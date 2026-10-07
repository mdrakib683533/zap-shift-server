const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");
initializeApp({
  credential: cert(serviceAccount),
});

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.iyvodwl.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");

    const db = client.db("zapShiftDB");

    // Collections
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const ridersCollection = db.collection("riders");

    // =========================
    // Custom Middleware
    // =========================

    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized message" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized message" });
      }

      // verify the token
      try {
        const decoded = await getAuth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // =========================
    // Users
    // =========================

    app.post("/users", async (req, res) => {
      try {
        const email = req.body.email;

        const userExists = await usersCollection.findOne({ email });

        if (userExists) {
          return res.status(200).send({
            message: "User already exists",
            inserted: false,
          });
        }

        const user = req.body;

        const result = await usersCollection.insertOne(user);

        res.send(result);
      } catch (error) {
        console.error("Failed to create user:", error);

        res.status(500).send({
          message: "Failed to create user",
        });
      }
    });

    // =========================
    // Get Parcels
    // =========================

    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email } = req.query;

        const query = email ? { createdBy: email } : {};

        const parcels = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Failed to get parcels:", error);

        res.status(500).send({
          message: "Failed to get parcels",
        });
      }
    });

    // =========================
    // Get Specific Parcel
    // =========================

    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Failed to get parcel:", error);

        res.status(500).send({
          message: "Failed to get parcel",
        });
      }
    });

    // =========================
    // Add New Parcel
    // =========================

    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;

        const result = await parcelsCollection.insertOne(parcel);

        res.send(result);
      } catch (error) {
        console.error("Failed to add parcel:", error);

        res.status(500).send({
          message: "Failed to add parcel",
        });
      }
    });

    // =========================
    // Delete Parcel
    // =========================

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Failed to delete parcel:", error);

        res.status(500).send({
          message: "Failed to delete parcel",
        });
      }
    });

    // =========================
    // Tracking
    // =========================

    app.post("/tracking", async (req, res) => {
      try {
        const trackingInfo = {
          ...req.body,
          createdAt: new Date(),
        };

        const result = await trackingCollection.insertOne(trackingInfo);

        res.send({
          success: true,
          message: "Tracking update added successfully",
          trackingId: result.insertedId,
        });
      } catch (error) {
        console.error("Failed to add tracking update:", error);

        res.status(500).send({
          success: false,
          message: "Failed to add tracking update",
        });
      }
    });

    // create rider application
    app.post("/riders", async (req, res) => {
      try {
        const rider = req.body;

        const result = await ridersCollection.insertOne(rider);

        res.send(result);
      } catch (error) {
        console.error("Failed to create rider application:", error);

        res.status(500).send({
          message: "Failed to create rider application",
        });
      }
    });

    // get pending riders
    app.get("/riders/pending", async (req, res) => {
      try {
        const query = { status: "pending" };

        const result = await ridersCollection.find(query).toArray();

        res.send(result);
      } catch (error) {
        console.error("Failed to get pending riders:", error);

        res.status(500).send({
          message: "Failed to get pending riders",
        });
      }
    });

    // get active riders
    app.get("/riders/active", async (req, res) => {
      try {
        // Find all riders whose status is active
        const query = {
          status: "active",
        };

        // Get active riders from database
        const result = await ridersCollection.find(query).toArray();

        // Send active riders to client
        res.send(result);
      } catch (error) {
        console.error("Failed to get active riders:", error);

        res.status(500).send({
          message: "Failed to get active riders",
        });
      }
    });

    // update rider status
    app.patch("/riders/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        // Find rider by MongoDB _id and update status
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: status,
            },
          },
        );

        // If rider was not found
        if (result.matchedCount === 0) {
          return res.status(404).send({
            message: "Rider not found",
          });
        }

        // Send success response
        res.send({
          message: "Rider status updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Failed to update rider status:", error);

        res.status(500).send({
          message: "Failed to update rider status",
        });
      }
    });

    // =========================
    // Get Payments
    // =========================

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        console.log("decoded", req.decoded);

        if (req.decoded.email !== userEmail) {
          return res.status(403).send({
            message: "forbidden access",
          });
        }

        const query = userEmail ? { userEmail: userEmail } : {};

        const result = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Failed to get payments:", error);

        res.status(500).send({
          message: "Failed to get payments",
        });
      }
    });

    // =========================
    // Record Payment
    // =========================

    app.post("/payments", async (req, res) => {
      const { parcelId, transactionId, paymentMethod, amount, userEmail } =
        req.body;

      try {
        // Check if this payment was already saved
        const existingPayment = await paymentsCollection.findOne({
          transactionId,
        });

        if (existingPayment) {
          return res.send({
            success: true,
            message: "Payment already saved",
            paymentId: existingPayment._id,
          });
        }

        // Update parcel payment status
        const parcelResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          },
        );

        if (parcelResult.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Parcel not found",
          });
        }

        // Save payment history
        const paymentInfo = {
          parcelId,
          userEmail,
          amount,
          paymentMethod,
          transactionId,
          payment_status: "paid",
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentInfo);

        res.send({
          success: true,
          message: "Payment successful and history saved",
          paymentId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment save error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // =========================
    // Create Payment Intent
    // =========================

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
        });

        res.json({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).json({
          error: error.message,
        });
      }
    });

    console.log("All routes are ready");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

run();

// =========================
// Test Route
// =========================

app.get("/", (req, res) => {
  res.send("Zap Shift Server is running");
});

// =========================
// Start Server
// =========================

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
