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
    const cashoutsCollection = db.collection("cashouts");

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

    // verify rider
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // Get all cash out requests for admin
    app.get("/admin/cashouts", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        // Get all cash out requests
        const cashouts = await cashoutsCollection
          .find({})
          .sort({ requestedAt: -1 })
          .toArray();

        // Send cash out requests
        res.send(cashouts);
      } catch (error) {
        console.error("Failed to get admin cash outs:", error);

        res.status(500).send({
          message: "Failed to get cash out requests",
        });
      }
    });

    // Admin dashboard KPI statistics
    app.get(
      "/admin/dashboard-stats",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // Count all parcels
          const totalParcels = await parcelsCollection.countDocuments();

          // Count parcels currently in transit
          const inTransit = await parcelsCollection.countDocuments({
            delivery_status: "in_transit",
          });

          // Count delivered parcels
          const delivered = await parcelsCollection.countDocuments({
            delivery_status: "delivered",
          });

          // Calculate total successful payments
          const paymentResult = await paymentsCollection
            .aggregate([
              { $match: { payment_status: "paid" } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ])
            .toArray();

          const totalPayments = paymentResult[0]?.total || 0;

          // Send dashboard statistics
          res.send({
            totalParcels,
            inTransit,
            delivered,
            totalPayments,
          });
        } catch (error) {
          console.error("Failed to get admin dashboard stats:", error);

          res.status(500).send({
            message: "Failed to get admin dashboard statistics",
          });
        }
      },
    );

    // Admin dashboard delivery status statistics
    app.get(
      "/admin/delivery-status-stats",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // Count parcels by delivery status
          const result = await parcelsCollection
            .aggregate([
              {
                $group: {
                  _id: "$delivery_status",
                  count: { $sum: 1 },
                },
              },
            ])
            .toArray();

          // Send status statistics
          res.send(result);
        } catch (error) {
          console.error("Failed to get delivery status stats:", error);

          res.status(500).send({
            message: "Failed to get delivery status statistics",
          });
        }
      },
    );

    // Admin dashboard monthly delivery statistics
    app.get(
      "/admin/monthly-deliveries",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // Group delivered parcels by year and month
          const result = await parcelsCollection
            .aggregate([
              {
                $match: {
                  delivery_status: "delivered",
                  deliveredAt: { $exists: true },
                },
              },
              {
                $group: {
                  _id: {
                    year: {
                      $year: { $toDate: "$deliveredAt" },
                    },
                    month: {
                      $month: { $toDate: "$deliveredAt" },
                    },
                  },
                  deliveries: { $sum: 1 },
                },
              },
              {
                $sort: {
                  "_id.year": 1,
                  "_id.month": 1,
                },
              },
            ])
            .toArray();

          // Convert month numbers into readable labels
          const monthlyData = result.map((item) => ({
            month: `${item._id.year}-${String(item._id.month).padStart(2, "0")}`,
            deliveries: item.deliveries,
          }));

          res.send(monthlyData);
        } catch (error) {
          console.error("Failed to get monthly deliveries:", error);

          res.status(500).send({
            message: "Failed to get monthly delivery statistics",
          });
        }
      },
    );

    // Admin dashboard: get recent parcels
    app.get(
      "/admin/recent-parcels",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcels = await parcelsCollection
            .find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.error("Failed to get recent parcels:", error);

          res.status(500).send({
            message: "Failed to get recent parcels",
          });
        }
      },
    );

    // Admin dashboard: get recent payments
    app.get(
      "/admin/recent-payments",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // Get the latest 5 payments
          const payments = await paymentsCollection
            .find({ payment_status: "paid" })
            .sort({ paid_at: -1 })
            .limit(5)
            .toArray();

          // Send recent payments to the admin
          res.send(payments);
        } catch (error) {
          console.error("Failed to get recent payments:", error);

          res.status(500).send({
            message: "Failed to get recent payments",
          });
        }
      },
    );
    

    // Get total pending riders count
    app.get(
      "/admin/pending-riders-count",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const count = await ridersCollection.countDocuments({
            status: "pending",
          });

          res.send({ count });
        } catch (error) {
          console.error("Failed to get pending riders count:", error);

          res.status(500).send({
            message: "Failed to get pending riders count",
          });
        }
      },
    );

    // Mark a cash out request as paid by admin
    app.patch(
      "/admin/cashouts/:id/pay",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          // Find the cash out request
          const cashout = await cashoutsCollection.findOne({
            _id: new ObjectId(id),
          });

          // Check if request exists
          if (!cashout) {
            return res.status(404).send({
              message: "Cash out request not found",
            });
          }

          // Prevent paying an already paid request
          if (cashout.status === "paid") {
            return res.status(400).send({
              message: "This request has already been paid",
            });
          }

          // Update status and payment time
          const result = await cashoutsCollection.updateOne(
            {
              _id: new ObjectId(id),
              status: "requested",
            },
            {
              $set: {
                status: "paid",
                paidAt: new Date(),
              },
            },
          );

          // Check if request was updated
          if (result.modifiedCount === 0) {
            return res.status(400).send({
              message: "Cash out request could not be updated",
            });
          }

          // Send success response
          res.send({
            success: true,
            message: "Cash out marked as paid successfully",
          });
        } catch (error) {
          console.error("Failed to mark cash out as paid:", error);

          res.status(500).send({
            message: "Failed to update cash out status",
          });
        }
      },
    );

    // Create cash out request for a completed delivery
    app.post("/cashouts", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const { parcelId } = req.body;

        // Check parcel ID
        if (!parcelId) {
          return res.status(400).send({
            message: "Parcel ID is required",
          });
        }

        // Find the parcel
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        // Get rider email from Firebase token
        const riderEmail = req.decoded.email;

        // Check this parcel belongs to this rider
        if (parcel.assignedRider?.email !== riderEmail) {
          return res.status(403).send({
            message: "You cannot cash out this delivery",
          });
        }

        // Check delivery is completed
        if (
          !["delivered", "service_center_delivered"].includes(
            parcel.delivery_status,
          )
        ) {
          return res.status(400).send({
            message: "This delivery is not completed yet",
          });
        }

        // Check if cash out already exists
        const existingCashout = await cashoutsCollection.findOne({
          parcelId: parcelId,
        });

        if (existingCashout) {
          return res.status(400).send({
            message: "Cash out request already exists for this delivery",
          });
        }

        // Check same district
        const sameDistrict =
          parcel.sender?.district?.toLowerCase() ===
          parcel.receiver?.district?.toLowerCase();

        // Same district = 80%, different district = 30%
        const earningRate = sameDistrict ? 0.8 : 0.3;

        // Get delivery fee
        const deliveryFee = Number(parcel.deliveryCost) || 0;

        // Calculate rider earning
        const earningAmount = Number((deliveryFee * earningRate).toFixed(2));

        // Create cash out request
        const cashout = {
          parcelId: parcelId,
          trackingId: parcel.trackingId,

          riderEmail: riderEmail,
          riderName: parcel.assignedRider?.name,

          earningAmount: earningAmount,

          status: "requested",

          requestedAt: new Date(),
          paidAt: null,
        };

        const result = await cashoutsCollection.insertOne(cashout);

        res.send({
          success: true,
          message: "Cash out request created successfully",
          cashoutId: result.insertedId,
          earningAmount: earningAmount,
        });
      } catch (error) {
        console.error("Failed to create cash out request:", error);

        res.status(500).send({
          message: "Failed to create cash out request",
        });
      }
    });

    // Get cash out summary for a rider
    app.get(
      "/cashouts/summary",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          // Get rider email from Firebase token
          const riderEmail = req.decoded.email;

          // Get all completed deliveries assigned to this rider
          const completedDeliveries = await parcelsCollection
            .find({
              "assignedRider.email": riderEmail,
              delivery_status: {
                $in: ["delivered", "service_center_delivered"],
              },
            })
            .toArray();

          // Calculate rider earning for one parcel
          const calculateEarning = (parcel) => {
            const sameDistrict =
              parcel.sender?.district?.toLowerCase() ===
              parcel.receiver?.district?.toLowerCase();

            // Same district: 80%, different district: 30%
            const earningRate = sameDistrict ? 0.8 : 0.3;
            const deliveryFee = Number(parcel.deliveryCost) || 0;

            return Number((deliveryFee * earningRate).toFixed(2));
          };

          // Get date in Bangladesh timezone (YYYY-MM-DD)
          const getBangladeshDate = (value) => {
            if (!value) return null;

            const date = new Date(value);

            if (Number.isNaN(date.getTime())) return null;

            const parts = new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Dhaka",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).formatToParts(date);

            const year = parts.find((part) => part.type === "year").value;
            const month = parts.find((part) => part.type === "month").value;
            const day = parts.find((part) => part.type === "day").value;

            return `${year}-${month}-${day}`;
          };

          // Get today's date in Bangladesh
          const today = getBangladeshDate(new Date());

          // Get current month and year
          const currentMonth = today.slice(0, 7);
          const currentYear = today.slice(0, 4);

          // Find Monday of the current week
          const weekStartDate = new Date(`${today}T00:00:00Z`);
          const dayOfWeek = weekStartDate.getUTCDay();
          const daysSinceMonday = (dayOfWeek + 6) % 7;

          weekStartDate.setUTCDate(
            weekStartDate.getUTCDate() - daysSinceMonday,
          );

          const weekStart = weekStartDate.toISOString().slice(0, 10);

          // Calculate total earnings from all completed deliveries
          const totalEarnings = Number(
            completedDeliveries
              .reduce((total, parcel) => {
                return total + calculateEarning(parcel);
              }, 0)
              .toFixed(2),
          );

          // Calculate income for today, this week, this month, and this year
          const incomeSummary = {
            todayIncome: 0,
            thisWeekIncome: 0,
            thisMonthIncome: 0,
            thisYearIncome: 0,
          };

          completedDeliveries.forEach((parcel) => {
            // Use the actual delivery completion date
            const deliveryDate = getBangladeshDate(parcel.deliveredAt);

            // Skip period calculations if delivery date is unavailable
            if (!deliveryDate) return;

            const earning = calculateEarning(parcel);

            // Today's income
            if (deliveryDate === today) {
              incomeSummary.todayIncome += earning;
            }

            // This week's income (Monday to today)
            if (deliveryDate >= weekStart && deliveryDate <= today) {
              incomeSummary.thisWeekIncome += earning;
            }

            // This month's income
            if (deliveryDate.slice(0, 7) === currentMonth) {
              incomeSummary.thisMonthIncome += earning;
            }

            // This year's income
            if (deliveryDate.slice(0, 4) === currentYear) {
              incomeSummary.thisYearIncome += earning;
            }
          });

          // Round income values to two decimal places
          Object.keys(incomeSummary).forEach((key) => {
            incomeSummary[key] = Number(incomeSummary[key].toFixed(2));
          });

          // Get all cash out requests for this rider
          const cashouts = await cashoutsCollection
            .find({ riderEmail })
            .toArray();

          // Calculate requested amount
          const requestedAmount = cashouts
            .filter((cashout) => cashout.status === "requested")
            .reduce(
              (total, cashout) => total + (Number(cashout.earningAmount) || 0),
              0,
            );

          // Calculate paid amount
          const cashedOut = cashouts
            .filter((cashout) => cashout.status === "paid")
            .reduce(
              (total, cashout) => total + (Number(cashout.earningAmount) || 0),
              0,
            );

          // Calculate available balance
          const availableBalance = Number(
            Math.max(0, totalEarnings - requestedAmount - cashedOut).toFixed(2),
          );

          // Send cash out summary and income breakdown
          res.send({
            totalEarnings,
            availableBalance,
            requestedAmount: Number(requestedAmount.toFixed(2)),
            cashedOut: Number(cashedOut.toFixed(2)),

            // Income by period
            ...incomeSummary,
          });
        } catch (error) {
          console.error("Failed to get cash out summary:", error);

          res.status(500).send({
            message: "Failed to get cash out summary",
          });
        }
      },
    );

    // Get cash out history for a rider
    app.get("/cashouts", verifyFBToken, verifyRider, async (req, res) => {
      try {
        // Get rider email from Firebase token
        const riderEmail = req.decoded.email;

        // Find this rider's cash out history
        const cashouts = await cashoutsCollection
          .find({ riderEmail })
          .sort({ requestedAt: -1 })
          .toArray();

        // Send cash out history
        res.send(cashouts);
      } catch (error) {
        console.error("Failed to get cash out history:", error);

        res.status(500).send({
          message: "Failed to get cash out history",
        });
      }
    });

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

    // Add a new parcel and create its first tracking update
    app.post("/parcels", async (req, res) => {
      try {
        // Get parcel data from client
        const parcel = req.body;

        // Save parcel to database
        const result = await parcelsCollection.insertOne(parcel);

        // Create the first tracking history
        const trackingInfo = {
          parcelId: result.insertedId.toString(),
          trackingId: parcel.trackingId,
          status: "parcel_submitted",
          message: "Parcel submitted successfully",
          location: parcel.sender?.district || "Unknown",
          createdAt: new Date(),
        };

        // Save tracking history
        await trackingCollection.insertOne(trackingInfo);

        // Send success response
        res.send({
          success: true,
          message: "Parcel added successfully with tracking history",
          insertedId: result.insertedId,
          trackingId: parcel.trackingId,
        });
      } catch (error) {
        console.error("Failed to add parcel:", error);

        res.status(500).send({
          success: false,
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

    // Get tracking updates by tracking ID
    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        // Get tracking ID from URL
        const { trackingId } = req.params;

        // Find all tracking updates for this parcel
        const trackingUpdates = await trackingCollection
          .find({ trackingId })
          .sort({ createdAt: 1 })
          .toArray();

        // Return tracking updates
        res.send(trackingUpdates);
      } catch (error) {
        console.error("Failed to get tracking updates:", error);

        res.status(500).send({
          message: "Failed to get tracking updates",
        });
      }
    });

    // Add a new tracking update
    app.post("/tracking", async (req, res) => {
      try {
        // Get tracking information from client
        // Add the current date and time
        const trackingInfo = {
          ...req.body,
          createdAt: new Date(),
        };

        // Save tracking information to MongoDB
        const result = await trackingCollection.insertOne(trackingInfo);

        // Send success response to client
        res.send({
          success: true,
          message: "Tracking update added successfully",
          trackingId: result.insertedId,
        });
      } catch (error) {
        // Log the error in the server terminal
        console.error("Failed to add tracking update:", error);

        // Send error response to client
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

    // get pending delivery tasks for a rider
    app.get("/rider/tasks", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const { email } = req.query;

        // Check rider email
        if (!email) {
          return res.status(400).send({
            message: "Rider email is required",
          });
        }

        // Find rider's pending and in-progress delivery tasks
        const query = {
          "assignedRider.email": email,
          delivery_status: {
            $in: ["rider_assigned", "in_transit"],
          },
        };

        const tasks = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(tasks);
      } catch (error) {
        console.error("Failed to get rider tasks:", error);

        res.status(500).send({
          message: "Failed to get rider tasks",
        });
      }
    });

    // Get completed deliveries for a rider
    app.get(
      "/rider/completed-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;

          if (!email) {
            return res.status(400).send({
              message: "Rider email is required",
            });
          }

          // Find completed deliveries of this rider
          const query = {
            "assignedRider.email": email,
            delivery_status: {
              $in: ["delivered", "service_center_delivered"],
            },
          };

          const completedDeliveries = await parcelsCollection
            .find(query)
            .sort({ deliveredAt: -1, createdAt: -1 })
            .toArray();

          // Calculate rider earning for each completed delivery
          const deliveriesWithEarnings = completedDeliveries.map((parcel) => {
            // Check if sender and receiver are in the same district
            const sameDistrict =
              parcel.sender?.district?.toLowerCase() ===
              parcel.receiver?.district?.toLowerCase();

            // Same district = 80%, different district = 30%
            const earningRate = sameDistrict ? 0.8 : 0.3;

            // Get delivery fee
            const deliveryFee = Number(parcel.deliveryCost) || 0;

            // Calculate rider earning
            const riderEarning = Number((deliveryFee * earningRate).toFixed(2));

            return {
              ...parcel,

              // Delivery information
              deliveryFee,
              earningRate: earningRate * 100,
              riderEarning,

              // Pickup and delivery time
              pickedUpAt: parcel.pickedUpAt || null,
              deliveredAt: parcel.deliveredAt || null,
            };
          });

          // Calculate total rider earnings
          const totalEarnings = Number(
            deliveriesWithEarnings
              .reduce((total, parcel) => total + parcel.riderEarning, 0)
              .toFixed(2),
          );

          // Send completed deliveries and earnings
          res.send({
            totalDeliveries: deliveriesWithEarnings.length,
            totalEarnings,
            deliveries: deliveriesWithEarnings,
          });
        } catch (error) {
          console.error("Failed to get completed deliveries:", error);

          res.status(500).send({
            message: "Failed to get completed deliveries",
          });
        }
      },
    );

    // Update rider delivery status and tracking history
    app.patch("/rider/tasks/:id/status", verifyFBToken, async (req, res) => {
      try {
        // Get parcel ID and new status
        const { id } = req.params;
        const { status } = req.body;

        // Allow only valid delivery status updates
        if (!["in_transit", "delivered"].includes(status)) {
          return res.status(400).send({
            message: "Invalid delivery status",
          });
        }

        // Find the parcel
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        // Return error if parcel does not exist
        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        // Prepare parcel update fields
        const updateFields = {
          delivery_status: status,
        };

        // Save pickup time when parcel is collected
        if (status === "in_transit") {
          updateFields.pickedUpAt = new Date();
        }

        // Save delivery time when parcel is delivered
        if (status === "delivered") {
          updateFields.deliveredAt = new Date();
        }

        // Update parcel status in MongoDB
        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateFields },
        );

        // Prepare a new tracking history entry
        const trackingInfo = {
          parcelId: id,
          trackingId: parcel.trackingId,
          status,
          message:
            status === "in_transit"
              ? "Parcel has been picked up and is in transit"
              : "Parcel has been delivered successfully",
          location:
            status === "in_transit"
              ? parcel.sender?.district || "Unknown"
              : parcel.receiver?.district || "Unknown",
          createdAt: new Date(),
        };

        // Save tracking history separately
        await trackingCollection.insertOne(trackingInfo);

        // Send success response
        res.send({
          success: true,
          message: "Delivery status and tracking history updated successfully",
        });
      } catch (error) {
        // Handle server or database errors
        console.error("Failed to update delivery status:", error);

        res.status(500).send({
          message: "Failed to update delivery status",
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
