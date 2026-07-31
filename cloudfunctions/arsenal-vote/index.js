const { createHash } = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");

const ENV_ID = "projecy-d7gbho4c9b0ab5614";
const COLLECTION = "arsenal_poll_receipts";
const OPTION_IDS = ["job-tracker", "assessment", "python", "ai-interview", "resume-check"];
const BASE_VOTES = {
  "job-tracker": 37,
  assessment: 28,
  python: 21,
  "ai-interview": 46,
  "resume-check": 34,
};
const ALLOWED_ORIGINS = new Set([
  "https://projecy-d7gbho4c9b0ab5614-1454002879.tcloudbaseapp.com",
  "https://2899959170-hue.github.io",
]);

const app = cloudbase.init({ env: ENV_ID });
const db = app.database();
const receipts = db.collection(COLLECTION);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function response(statusCode, payload, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
  }
  return { statusCode, headers, body: JSON.stringify(payload) };
}

async function getVotes() {
  const liveCounts = await Promise.all(
    OPTION_IDS.map(async (optionId) => {
      const result = await receipts.where({ optionId }).count();
      return Number(result.total || 0);
    }),
  );

  return OPTION_IDS.reduce((result, optionId, index) => {
    result[optionId] = BASE_VOTES[optionId] + liveCounts[index];
    return result;
  }, {});
}

async function findReceipt(receiptId) {
  try {
    const result = await receipts.doc(receiptId).get();
    return result.data && result.data.length ? result.data[0] : null;
  } catch (error) {
    if (/not exist|NOT_FOUND|DATABASE_COLLECTION_NOT_EXIST/i.test(error.message || "")) {
      return null;
    }
    throw error;
  }
}

async function handleVote(body) {
  const optionId = String(body.optionId || "");
  const clientId = String(body.clientId || "");

  if (!OPTION_IDS.includes(optionId)) {
    return { status: 400, payload: { ok: false, message: "无效的投票选项" } };
  }
  if (!/^[a-zA-Z0-9._-]{16,128}$/.test(clientId)) {
    return { status: 400, payload: { ok: false, message: "投票凭证无效，请刷新重试" } };
  }

  const receiptId = createHash("sha256")
    .update(`ahan-arsenal-poll-v1:${clientId}`)
    .digest("hex");
  const existing = await findReceipt(receiptId);

  if (existing) {
    return {
      status: 200,
      payload: {
        ok: true,
        alreadyVoted: true,
        votedOption: existing.optionId,
        votes: await getVotes(),
      },
    };
  }

  try {
    await receipts.doc(receiptId).set({
      optionId,
      createdAt: db.serverDate(),
      source: "live",
    });
  } catch (error) {
    const raced = await findReceipt(receiptId);
    if (!raced) throw error;
    return {
      status: 200,
      payload: {
        ok: true,
        alreadyVoted: true,
        votedOption: raced.optionId,
        votes: await getVotes(),
      },
    };
  }

  return {
    status: 200,
    payload: {
      ok: true,
      alreadyVoted: false,
      votedOption: optionId,
      votes: await getVotes(),
    },
  };
}

exports.main = async (event) => {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || "";
  const method = String(event.httpMethod || "GET").toUpperCase();

  if (!isAllowedOrigin(origin)) {
    return response(403, { ok: false, message: "来源未授权" }, origin);
  }
  if (method === "OPTIONS") {
    return response(204, {}, origin);
  }

  try {
    if (method === "GET") {
      return response(200, { ok: true, votes: await getVotes() }, origin);
    }
    if (method === "POST") {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "{}";
      if (rawBody.length > 2048) {
        return response(413, { ok: false, message: "请求内容过大" }, origin);
      }
      const result = await handleVote(JSON.parse(rawBody));
      return response(result.status, result.payload, origin);
    }
    return response(405, { ok: false, message: "不支持的请求方式" }, origin);
  } catch (error) {
    console.error("arsenal-vote error", error);
    return response(500, { ok: false, message: "投票服务暂时繁忙，请稍后再试" }, origin);
  }
};
