import fs from "node:fs";
import express from "express";
import cors from "cors";
import { TikTokLiveConnection } from "tiktok-live-connector";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SOURCE_URL = "https://github.com/LBTown85/square-one-live-checker";
const CYCLE_MS = Math.max(180_000, Number(process.env.CYCLE_MS || 600_000));
const CHECK_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(process.env.CHECK_CONCURRENCY || 8))
);
const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.REQUEST_TIMEOUT_MS || 12_000)
);
const LIVE_STALE_MS = Math.max(CYCLE_MS * 2, 900_000);

const rosterUrl = new URL("./creators.json", import.meta.url);
const roster = JSON.parse(fs.readFileSync(rosterUrl, "utf8"));

const creators = [
  ...new Set(
    roster
      .map((value) => String(value || "").trim().replace(/^@/, ""))
      .filter((value) => /^[A-Za-z0-9._]{2,24}$/.test(value))
  )
];

if (!creators.length) {
  throw new Error("No valid creators were found in creators.json");
}

const creatorState = new Map(
  creators.map((username) => [
    username,
    {
      username,
      result: null,
      checkedAt: null,
      error: null
    }
  ])
);

let nextIndex = 0;
let latestCheckedAt = null;

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use((_req, res, next) => {
  res.set("Link", `<${SOURCE_URL}>; rel="source"`);
  next();
});
app.disable("x-powered-by");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function firstUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] || "";
  return value.url_list?.[0] || value.urlList?.[0] || value.url || "";
}

function timeLive(createTime) {
  const startedAt = Number(createTime || 0) * 1000;
  if (!startedAt) return "";

  const seconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000)
  );

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return `${hours} hr${hours === 1 ? "" : "s"}${
    minutes ? ` ${minutes} min` : ""
  }`;
}

async function checkCreator(username) {
  const connection = new TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: false,
    enableExtendedGiftInfo: false,
    authenticateWs: false,
    useMobile: false
  });

  const isLive = await withTimeout(
    connection.fetchIsLive(),
    REQUEST_TIMEOUT_MS,
    `@${username}`
  );

  if (!isLive) {
    return null;
  }

  let room = null;

  try {
    room = await withTimeout(
      connection.fetchRoomInfo(),
      REQUEST_TIMEOUT_MS,
      `room info for @${username}`
    );
  } catch {
    // The card can still link to the creator's LIVE when room details are unavailable.
  }

  const owner = room?.owner || room?.user || {};
  const displayName =
    owner.nickname || owner.display_id || owner.unique_id || username;
  const viewerCount =
    room?.user_count ??
    room?.stats?.user_count ??
    room?.stats?.userCount ??
    "";

  return {
    name: displayName,
    username: `@${username}`,
    profileUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}/live`,
    avatarUrl: firstUrl(
      owner.avatar_medium || owner.avatar_thumb || owner.avatar_larger
    ),
    category: room?.title || "TikTok LIVE",
    viewers: viewerCount ? String(viewerCount) : "",
    liveSince: timeLive(room?.create_time || room?.createTime),
    roomId: String(room?.id || room?.room_id || "")
  };
}

function getNextUsername() {
  const username = creators[nextIndex % creators.length];
  nextIndex += 1;
  return username;
}

function updateCreatorState(username, result, error = null) {
  const checkedAt = new Date().toISOString();
  const previous = creatorState.get(username);

  creatorState.set(username, {
    username,
    result: error ? previous?.result || null : result,
    checkedAt,
    error: error ? String(error.message || error) : null
  });

  latestCheckedAt = checkedAt;
}

async function checkerWorker(workerNumber) {
  const targetSpacingMs = Math.max(
    250,
    Math.floor((CYCLE_MS * CHECK_CONCURRENCY) / creators.length)
  );

  await sleep(workerNumber * 250);

  while (true) {
    const startedAt = Date.now();
    const username = getNextUsername();

    try {
      const result = await checkCreator(username);
      updateCreatorState(username, result);
    } catch (error) {
      updateCreatorState(username, null, error);
    }

    const elapsedMs = Date.now() - startedAt;
    await sleep(Math.max(250, targetSpacingMs - elapsedMs));
  }
}

function getSnapshot() {
  const now = Date.now();
  const states = [...creatorState.values()];
  const checked = states.filter((item) => item.checkedAt).length;
  const errors = states.filter((item) => item.error).length;

  const liveCreators = states
    .filter((item) => {
      if (!item.result || !item.checkedAt) return false;
      const age = now - new Date(item.checkedAt).getTime();
      return age <= LIVE_STALE_MS;
    })
    .map((item) => item.result)
    .sort((a, b) => {
      const viewerDifference =
        Number(b.viewers || 0) - Number(a.viewers || 0);
      if (viewerDifference !== 0) return viewerDifference;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

  return {
    creators: liveCreators,
    liveCount: liveCreators.length,
    checked,
    total: creators.length,
    scanProgress: Math.round((checked / creators.length) * 100),
    updatedAt: latestCheckedAt,
    refreshing: checked < creators.length,
    errorCount: errors,
    cycleMinutes: Math.round(CYCLE_MS / 60_000)
  };
}

app.get("/", (_req, res) => {
  const snapshot = getSnapshot();

  res
    .type("text/plain")
    .send(
      `Square One LIVE checker is running.\n` +
        `Monitoring ${snapshot.total} creators.\n` +
        `Currently LIVE: ${snapshot.liveCount}\n` +
        `Use /live.json for the public feed.\n` +
        `Source: ${SOURCE_URL}`
    );
});

app.get("/source", (_req, res) => {
  res.redirect(302, SOURCE_URL);
});

app.get("/health", (_req, res) => {
  const snapshot = getSnapshot();

  res.json({
    ok: true,
    updatedAt: snapshot.updatedAt,
    liveCount: snapshot.liveCount,
    checked: snapshot.checked,
    total: snapshot.total,
    errorCount: snapshot.errorCount
  });
});

app.get("/live.json", (_req, res) => {
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.json(getSnapshot());
});

app.get("/refresh", (_req, res) => {
  nextIndex = 0;
  res.json({
    ok: true,
    message: "The roster was moved to the front of the rolling scan queue."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Square One LIVE checker listening on port ${PORT} and monitoring ${creators.length} creators`
  );

  for (let worker = 0; worker < CHECK_CONCURRENCY; worker += 1) {
    checkerWorker(worker).catch((error) => {
      console.error(`Checker worker ${worker} stopped`, error);
    });
  }
});
