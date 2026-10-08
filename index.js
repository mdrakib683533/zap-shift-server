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

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // Search a user by email
    app.get("/users/search", async (req, res) => {
      try {
        const email = req.query.email;

        // Check if email is provided
        if (!email) {
          return res.status(400).send({
            message: "Email is required",
          });
        }

        // Find user by email
        const user = await usersCollection.findOne({
          email: { $regex: `^${email}$`, $options: "i" },
        });

        // If user does not exist
        if (!user) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        // Send user data
        res.send(user);
      } catch (error) {
        console.error("Failed to search user:", error);

        res.status(500).send({
          message: "Failed to search user",
        });
      }
    });

    // Suggest users by email
    app.get("/users/suggestions", async (req, res) => {
      try {
        const email = req.query.email;

        // If email is empty
        if (!email) {
          return res.send([]);
        }

        // Find users whose email starts with the searched text
        const users = await usersCollection
          .find({
            email: {
              $regex: `^${email}`,
              $options: "i",
            },
          })
          .project({
            email: 1,
            role: 1,
            created_at: 1,
            last_log_in: 1,
          })
          .limit(10)
          .toArray();

        // Send user suggestions
        res.send(users);
      } catch (error) {
        console.error("Failed to get user suggestions:", error);

        res.status(500).send({
          message: "Failed to get user suggestions",
        });
      }
    });

    // Get user role by email
    app.get("/users/role/:email", async (req, res) => {
      try {
        const email = req.params.email;

        // Find user by email
        const user = await usersCollection.findOne(
          { email: email },
          { projection: { role: 1 } },
        );

        // User not found
        if (!user) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        // Send role
        res.send({
          role: user.role || "user",
        });
      } catch (error) {
        console.error("Failed to get user role:", error);

        res.status(500).send({
          message: "Failed to get user role",
        });
      }
    });

    // Make a user admin
    app.patch(
      "/users/:id/make-admin",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          // Update user's role to admin
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                role: "admin",
              },
            },
          );

          // User not found
          if (result.matchedCount === 0) {
            return res.status(404).send({
              message: "User not found",
            });
          }

          // Successfully made admin
          res.send({
            message: "User is now an admin",
          });
        } catch (error) {
          console.error("Failed to make admin:", error);

          res.status(500).send({
            message: "Failed to make admin",
          });
        }
      },
    );

    // Remove admin role from a user
    app.patch("/users/:id/remove-admin", async (req, res) => {
      try {
        const id = req.params.id;

        // Remove the admin role
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              role: "user",
            },
          },
        );

        // User not found
        if (result.matchedCount === 0) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        // Successfully removed admin role
        res.send({
          message: "Admin role removed",
        });
      } catch (error) {
        console.error("Failed to remove admin:", error);

        res.status(500).send({
          message: "Failed to remove admin",
        });
      }
    });

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
        const { email, payment_status, delivery_status } = req.query;
        let query = {};
        if (email) {
          query = { createdBy: email };
        }
        if (payment_status) {
          query.payment_status = payment_status;
        }
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        console.log("parcel query", req.query, query);

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
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
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
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
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

    // Get active riders by district, fallback to region
    app.get("/riders", verifyFBToken, async (req, res) => {
      try {
        const { region, district } = req.query;

        console.log("Requested region:", region);
        console.log("Requested district:", district);

        if (!region || !district) {
          return res.status(400).send({
            message: "Region and district are required",
          });
        }

        // First: find active riders from the same district
        const districtRiders = await ridersCollection
          .find({
            region: region,
            district: district,
            status: "active",
          })
          .toArray();

        // If same district riders exist, return them
        if (districtRiders.length > 0) {
          console.log("Same district riders:", districtRiders);

          return res.send(districtRiders);
        }

        // If no same district rider, find active riders from same region
        const regionRiders = await ridersCollection
          .find({
            region: region,
            status: "active",
          })
          .toArray();

        console.log("Same region riders:", regionRiders);

        res.send(regionRiders);
      } catch (error) {
        console.error("Failed to get riders:", error);

        res.status(500).send({
          message: "Failed to get riders",
        });
      }
    });

    // Assign rider to a parcel
    app.patch("/parcels/:id/assign-rider", verifyFBToken, async (req, res) => {
      try {
        const { id } = req.params;
        const { rider } = req.body;

        // Update parcel with assigned rider
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              assignedRider: {
                name: rider.name,
                email: rider.email,
                region: rider.region,
                district: rider.district,
              },
              delivery_status: "rider_assigned",
            },
          },
        );

        // Parcel not found
        if (result.matchedCount === 0) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        // Send success response
        res.send({
          message: "Rider assigned successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Failed to assign rider:", error);

        res.status(500).send({
          message: "Failed to assign rider",
        });
      }
    });

    // update rider status
    app.patch("/riders/:id/status", async (req, res) => {
      try {
        // Get rider ID from URL
        const { id } = req.params;

        // Get new status from request body
        const { status } = req.body;

        // Find the rider using MongoDB _id
        const rider = await ridersCollection.findOne({
          _id: new ObjectId(id),
        });

        // If rider is not found
        if (!rider) {
          return res.status(404).send({
            message: "Rider not found",
          });
        }

        // Update rider status
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: status,
            },
          },
        );

        // If rider becomes active,
        // change the user's role from "user" to "rider"
        if (status === "active") {
          await usersCollection.updateOne(
            { email: rider.email },
            {
              $set: {
                role: "rider",
              },
            },
          );
        }

        // Send success response
        res.send({
          message: "Rider status updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        // Handle server/database errors
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
