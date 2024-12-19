import { serve } from "bun"

const PSK = Bun.env.PSK
if (!PSK) {
    console.error(`fatal: no PSK in ENV`)
    process.exit(1)
}

const PUSHOVER_TOKEN = Bun.env.PUSHOVER_TOKEN
if (!PUSHOVER_TOKEN) {
    console.error(`fatal: no PUSHOVER_TOKEN in ENV`)
    process.exit(1)
}

const PUSHOVER_USER = Bun.env.PUSHOVER_USER
if (!PUSHOVER_USER) {
    console.error(`fatal: no PUSHOVER_USER in ENV`)
    process.exit(1)
}

interface MessageQueueBody {
    [messageKey: string]: QueuedMessage
}

interface QueuedMessage {
    title?: string
    message: string
    timestamp: number
}

const dbFile = Bun.file("./message_db.json", {type: "application/json"})
let db: MessageQueueBody

if (dbFile.size === 0) {
    db = {}
} else {
    const dbFileJSONStr = await dbFile.text()
    try {
        const dbFileJSON = JSON.parse(dbFileJSONStr)
        db = dbFileJSON
    } catch (err) {
        console.error(`error reading db file. recreating.`)
        db = {}
    }
}

async function syncDb(): Promise<void> {
    await Bun.write(dbFile, JSON.stringify(db))
}

function respond400(): Response {
    return Response.json(
    {
        "type": "error",
        "result": {
            "message": "bad request"
        }
    }, 
    {
        status: 400
    })
}

function respond200(): Response {
    return Response.json(
    {
        "type": "ok",
        "result": {}
    }, 
    {
        status: 200
    })
}

const timers: Map<string, Timer> = new Map();

serve({
    port: 1414,
    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)
        if (url.pathname === "/message_queue.json" && req.method === "POST") {
            // check the PSK
            const token = req.headers.get("Authorization")
            if (token !== `Bearer ${PSK}`) {
                return Response.json(
                {
                    "type": "error",
                    "result": {
                        "message": "unauthorized"
                    }
                }, 
                {
                    status: 401
                })
            }
            try {
                const reqJSON: MessageQueueBody = await req.json()
                // validate the new message queue
                for (const [key, message] of Object.entries(reqJSON)) {
                    if (key.length === 0 || key.length > 64) {
                        return respond400()
                    }
                    if (message.message.length === 0 || message.message.length > 1024) {
                        return respond400()
                    }
                    if (message.title && message.title.length > 250) {
                        return respond400()
                    }
                    const now = new Date().getTime()
                    if (typeof(message.timestamp) !== "number") {
                        return respond400()
                    }
                    if (now > message.timestamp) {
                        return respond400()
                    }
                }
                // all valid
                for (const [key, message] of Object.entries(reqJSON)) {
                    db[key] = message
                    // invalidate timers associated with this key, if any.
                    const timer = timers.get(key)
                    if (timer) {
                        clearTimeout(timer)
                        timers.delete(key)
                    }
                }
                syncDb()

            } catch (error) {
                return respond400()
            }
        } else if (url.pathname === "/message_queue.json" && req.method === "GET") {
            return Response.json(db)
        }
        return respond200()
    }
})

const UPDATE_INTERVAL = 5000

async function sendNotification(message: QueuedMessage) {
    const pushoverRequest = JSON.stringify({
        token: PUSHOVER_TOKEN,
        user: PUSHOVER_USER,
        message: message.message,
        title: message.title,
        timestamp: Math.round(message.timestamp / 1000.0)
    })
    const res = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pushoverRequest
    })
    if (!res.ok) {
        const bodyText = await res.text()
        console.error(`pushover API error ${res.status}: ${bodyText}`)
        return
    }
}

async function daemonMain() {
    let lastUpdated = new Date().getTime();
    async function update() {
        if (new Date().getTime() - lastUpdated > (UPDATE_INTERVAL + 100)) {
            // Time has drifted too far for our timers to be accurate, reset them all
            console.log("pushover-bridge: timers drifted, resetting...");
            for (const [_,timer] of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        }

        // Remove timers without an associated key in db
        const dbKeys = new Set(Object.keys(db))
        const timerKeys = new Set(timers.keys())
        for (const removedKey of timerKeys.difference(dbKeys)) {
            const t = timers.get(removedKey)
            clearTimeout(t)
            timers.delete(removedKey)
        }

        // Create timers without an associated key in timers map
        for (const newKey of dbKeys.difference(timerKeys)) {
            const message = db[newKey]
            const interval = message.timestamp - new Date().getTime()
            timers.set(newKey, setTimeout(() => {
                sendNotification(message)
                delete db[newKey]
                timers.delete(newKey)
                syncDb()                
            }, interval))
        }

        lastUpdated = new Date().getTime()
    }
    update()
    setInterval(() => {update()}, UPDATE_INTERVAL)
}

daemonMain()
