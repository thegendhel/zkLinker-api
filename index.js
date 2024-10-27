const express = require("express");
let { ReclaimClient } = require("@reclaimprotocol/zk-fetch");
let { Reclaim } = require("@reclaimprotocol/js-sdk");
const dotenv = require("dotenv");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

dotenv.config();

const corsOptions = {
  credentials: true,
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
};

const reclaimClient = new ReclaimClient(
  process.env.RECLAIM_APP_ID,
  process.env.RECLAIM_APP_SECRET,
  true
);

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
const port = 7788;

const cacheDir = path.join(__dirname, "cache");

let baseResult = {
  success: false,
  error: "",
  data: {},
};

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir);
}

const generateCacheKey = (reqSerialized) => {
  return crypto.createHash("md5").update(reqSerialized).digest("hex") + ".json";
};

const readCache = (cacheFile) => {
  const filePath = path.join(cacheDir, cacheFile);
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath);
    return JSON.parse(data.toString());
  }
  return null;
};

const writeCache = (cacheFile, data) => {
  const filePath = path.join(cacheDir, cacheFile);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      data,
      cachedAt: Date.now(),
    })
  );
};

async function generateProof(data) {
  try {
    let publicOptions = {
      method: data.method,
      headers: data.header,
    };

    let privateOptions = {};

    if (data.responseMatches && data.responseMatches.length > 0) {
      privateOptions.responseMatches = data.responseMatches;
    }

    if (data.responseRedactions && data.responseRedactions.length > 0) {
      privateOptions.responseRedactions = data.responseRedactions;
    }

    const proof = await reclaimClient.zkFetch(
      data.url,
      publicOptions,
      privateOptions,
      2,
      3000
    );

    if (!proof) {
      baseResult.error = "Failed to generate proof";
      return res.status(400).json(baseResult);
    }

    const isValid = await Reclaim.verifySignedProof(proof);
    if (!isValid) {
      baseResult.error = "Proof is invalid";
      return res.status(400).json(baseResult);
    }

    const tProof = await Reclaim.transformForOnchain(proof);

    baseResult.data = { proof: proof, transformed: tProof };
    return res.status(200).json(baseResult);

  } catch (err) {
    baseResult.error = err.message;
    return res.status(400).json(baseResult);
  }
}

app.post("/proof", async function (req, res) {
  const cacheKey = generateCacheKey(JSON.stringify(req.body));
  const cache = readCache(cacheKey);

  if (cache) {
    baseResult.success = true;
    baseResult.error = "";
    baseResult.data = cache.data;
    return res.status(200).json(baseResult);
  }

  try {
    const result = await generateProof(req.body);

    if (!result.success) {
      baseResult.error = result.error;
      return res.status(400).json(baseResult);
    }

    let response = {
      id: cacheKey.replace(".json", ""),
      url: req.body.url,
      proof: result.data.proof,
      transformed: result.data.transformed,
    };

    baseResult.success = true;
    baseResult.error = "";
    baseResult.data = response;

    writeCache(cacheKey, response);

    return res.status(200).json(baseResult);
  } catch (e) {
    console.error(e);
    baseResult.error = e.message;
    return res.status(500).json(baseResult);
  }
});

app.get("/proof/:id", function (req, res) {
  const cache = readCache(req.params.id + ".json");

  if (cache) {
    return res.status(200).json(cache.data);
  }

  return res.status(404).json({ error: "NotFound" });
});

app.listen(port, () => {
  console.log(`ZKlinker API listening on port ${port}`);
});
