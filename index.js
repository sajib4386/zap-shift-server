const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000
const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
    const prefix = "PRCL";

    // YYYYMMDD format date
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    // random 3 bytes → 6 hex chars
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();

    return `${prefix}-${date}-${random}`;
}



// MIdleware
app.use(express.json());
app.use(cors());

// JWT
const verifyFBToken = async (req, res, next) => {
    console.log('headers in the middleware', req.headers?.authorization)
    const token = req.headers?.authorization
    if (!token) {
        return res.status(401).send({ message: 'Unauthorized Access' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next()
    }
    catch (err) {
        return res.status(401).send({ message: 'Unauthorized Access' })
    }

}


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@sajib43.hq7hrle.mongodb.net/?appName=Sajib43`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});



async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        // await client.connect();

        const db = client.db('zap-shift-db');
        const userCollection = db.collection('users')
        const parcelsCollection = db.collection('parcels');
        // Payment History
        const paymentCollection = db.collection('payments')
        const ridersCollection = db.collection('riders')

        // Admin Verify
        // must be used after verifyFBToken middleware
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email }
            const user = await userCollection.findOne(query);

            if (!user || user.role !== 'Admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next()
        }


        // Users APIs

        // All Users 
        app.get("/users", verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {}
            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }

            const cursor = userCollection.find(query);
            const result = await cursor.toArray();
            res.send(result)
        })

        // User Create
        app.post("/users", async (req, res) => {
            const user = req.body;
            user.role = 'User';
            user.createdAt = new Date();

            const email = user.email;
            const userExist = await userCollection.findOne({ email })
            if (userExist) {
                return res.send({ message: 'user exist' })
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        // User Update
        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await userCollection.updateOne(query, updateDoc);
            res.send(result)
        })

        // এখানে user কোন role এ  আছে সেটা দেখা হচ্ছে (normal user,admin,rider)
        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await userCollection.findOne(query)
            res.send({ role: user?.role || 'user' })
        })

        // Rider APIs

        // All Riders APIs
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending';
            rider.createdAt = new Date();

            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        })

        // All Pending Rider
        // app.get('/riders', async (req, res) => {
        //     const { status, district, workStatus } = req.query;
        //     const query = {};

        //     if (status) {
        //         query.status = status;
        //     }
        //     if (district) {
        //         query.district = district;
        //     }
        //     if (workStatus) {
        //         query.workStatus = workStatus;
        //     }

        //     const cursor = ridersCollection.find(query);
        //     const result = await cursor.toArray();
        //     res.send(result)
        // })

        app.get('/riders', async (req, res) => {
            const query = {};

            if (req.query.status) {
                query.status = req.query.status;
            }

            if (req.query.district && req.query.district !== "undefined") {
                query.district = req.query.district;
            }

            if (req.query.workStatus && req.query.workStatus !== "undefined") {
                query.workStatus = req.query.workStatus;
            }

            const cursor = ridersCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });


        // Specific rider API
        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    status: status,
                    workStatus: 'Available'
                }
            }
            const result = await ridersCollection.updateOne(query, updateDoc);

            if (status === 'approved') {
                const email = req.body.email;
                const useQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await userCollection.updateOne(useQuery, updateUser)
            }
            res.send(result)
        })

        // All Parcel APIs
        app.get("/parcels", async (req, res) => {
            const query = {}
            const { email, deliveryStatus } = req.query;

            if (email) {
                query.senderEmail = email;
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const optinos = { sort: { createdAt: -1 } }

            const cursor = parcelsCollection.find(query, optinos)
            const result = await cursor.toArray();
            res.send(result)
        })


        // Specific/One parcel API
        app.get("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelsCollection.findOne(query);
            res.send(result)
        })

        app.post("/parcels", async (req, res) => {
            const parcel = req.body;
            parcel.createdAt = new Date();
            const result = await parcelsCollection.insertOne(parcel);
            res.send(result)
        })


        app.delete("/parcels/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelsCollection.deleteOne(query)
            res.send(result)
        })

        // parcel update
        app.patch("/parcels/:id", async (req, res) => {
            const { riderId, riderName, riderEmail, } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }
            const result = await parcelsCollection.updateOne(query,updateDoc)

            // update rider information 
            const riderQuery = {_id:new ObjectId(riderId)}
            const riderUpdateDoc = {
                $set:{
                    workStatus:'in_delivery'
                }
            }
            const riderResult = await ridersCollection.updateOne(riderQuery,riderUpdateDoc)
            res.send(riderResult)
        })


        // Payment Related APIs

        // OLD
        // app.post('/create-checkout-session', async (req, res) => {
        //     const paymentInfo = req.body;
        //     const amount = parseInt(paymentInfo.cost) * 100;
        //     const session = await stripe.checkout.sessions.create({
        //         line_items: [
        //             {
        //                 // Provide the exact Price ID (for example, price_1234) of the product you want to sell
        //                 price_data: {
        //                     currency: 'USD',
        //                     unit_amount: amount,
        //                     product_data: {
        //                         name: paymentInfo.parcelName
        //                     }
        //                 },
        //                 quantity: 1,
        //             },
        //         ],
        //         customer_email: paymentInfo.senderEmail,
        //         mode: 'payment',
        //         metadata: {
        //             parcelId: paymentInfo.parcelId
        //         },
        //         success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        //         cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,

        //     });
        //     console.log(process.env.SITE_DOMAIN)
        //     console.log(session);
        //     res.send({ url: session.url })
        // })

        // Payment API
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: `Please Pay For: ${paymentInfo.parcelName}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,

            });
            console.log(process.env.SITE_DOMAIN)
            console.log(session);
            res.send({ url: session.url })
        })


        // Payment Update
        app.patch("/payment-success", async (req, res) => {
            const sessionId = req.query.session_id;

            const session = await stripe.checkout.sessions.retrieve(sessionId);
            console.log('session retrieve', session)

            // যখন payment করার হবে তখন যাতে একাধিকবার transactionId না থাকে ডাটার মধ্যে
            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }
            const paymentExist = await paymentCollection.findOne(query)
            if (paymentExist) {
                return res.send({
                    message: 'alresdy exist',
                    transactionId,
                    trackingId: paymentExist.trackingId
                })
            }
            const trackingId = generateTrackingId();
            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup',
                        trackingId: trackingId
                    }
                }

                const result = await parcelsCollection.updateOne(query, update)

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentCollection.insertOne(payment)

                    res.send({
                        success: true,
                        modifyParcel: result,
                        paymentInfo: resultPayment,
                        trackingId: trackingId,
                        transactionId: session.payment_intent
                    })
                }
            }

            res.send({ success: false })
        })


        // এখানে যার email সেই তার payment history দেখতে পারবে। অন্য আর কারো তথ্য দেখতে পারবে না
        app.get("/payments", verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                query.customerEmail = email

                // check email address 
                // যখন কেউ অন্য আরেকজনের email এর তথ্য দেখতে চাইবে তখন তাকে দেওয়া হবে না
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }

            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = (await cursor.toArray());
            res.send(result)
        })



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Zap-shift server is running')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
