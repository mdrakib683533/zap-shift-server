const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.iyvodwl.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");

    const db = client.db("zapShiftDB");
    const parcelsCollection = db.collection("parcels");

    // Get parcels
    app.get("/parcels", async (req, res) => {
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

    // Add a new parcel
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

    // Delete parcel
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
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

run();

// Test route
app.get("/", (req, res) => {
  res.send("Zap Shift Server is running");
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
