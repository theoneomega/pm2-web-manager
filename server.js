require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const pm2 = require('pm2');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const session = require('express-session');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 4747;
const BASE_DIR = process.env.PM2_BASE_DIR || '/home/omega';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Validate essential environment variables
if (!ADMIN_PASSWORD || !SESSION_SECRET) {
    console.error("Error: ADMIN_PASSWORD and SESSION_SECRET must be defined in the .env file");
    process.exit(1);
}

const app = express();

// --- SECURITY & GENERAL MIDDLEWARE ---
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: `http://localhost:${PORT}`, credentials: false }));
app.use(morgan('tiny'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// --- SERVE FRONTEND ---
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION ROUTES ---
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.json({ ok: true, message: 'Login successful' });
    } else {
        res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ ok: false, error: 'Could not log out' });
        }
        res.clearCookie('connect.sid');
        res.json({ ok: true, message: 'Session closed' });
    });
});

// --- AUTHORIZATION MIDDLEWARE FOR API ---
const requireAuth = (req, res, next) => {
    if (req.session.loggedIn) {
        next();
    } else {
        res.status(401).json({ error: 'unauthorized' });
    }
};

// --- PM2 CONNECTION ---
let pm2Ready = false;
pm2.connect(err => {
    if (err) {
        console.error("Error connecting to PM2:", err);
        process.exit(2);
    }
    pm2Ready = true;
    console.log('Connected to PM2 successfully.');
});

process.on('SIGINT', () => {
    pm2.disconnect();
    process.exit();
});

// Helper function to wrap PM2 calls and handle connection state
function withPM2(fn, res) {
    if (!pm2Ready) return res.status(503).json({ error: 'PM2 is not ready' });
    Promise.resolve(fn()).catch(e => {
        console.error("Error in PM2 operation:", e);
        res.status(500).json({ error: String(e) });
    });
}

// --- API ROUTES (PROTECTED) ---
const apiRouter = express.Router();
apiRouter.use(requireAuth);

// GET /api/processes - List all processes
apiRouter.get('/processes', (req, res) => {
    withPM2(() => {
        pm2.list((err, list) => {
            if (err) return res.status(500).json({ error: String(err) });
            res.json(list.map(p => ({
                id: p.pm_id, name: p.name, pid: p.pid, status: p.pm2_env.status,
                script: p.pm2_env.pm_exec_path, cpu: p.monit.cpu || 0, memory: p.monit.memory || 0,
                uptime: p.pm2_env.pm_uptime
            })));
        });
    }, res);
});

// POST /api/start - Start a new process
apiRouter.post('/start', (req, res) => {
    withPM2(() => {
        const { script, name, args = [], instances = 1, exec_mode = 'fork' } = req.body || {};
        if (!script || !name) return res.status(400).json({ error: 'script and name are required' });

        const scriptPath = path.resolve(BASE_DIR, script);
        if (!fs.existsSync(scriptPath) || !scriptPath.startsWith(path.resolve(BASE_DIR))) {
            return res.status(403).json({ error: 'Script path not allowed or does not exist' });
        }

        pm2.start({
            script: scriptPath, name, args, instances, exec_mode,
            cwd: path.dirname(scriptPath),
            env: { ...process.env }
        }, (err, proc) => {
            if (err) return res.status(500).json({ error: String(err) });
            res.json({ ok: true, pid: proc[0].pid, id: proc[0].pm2_env.pm_id });
        });
    }, res);
});

// Process actions: restart, stop, delete
['restart', 'stop'].forEach(action => {
    apiRouter.post(`/${action}/:id`, (req, res) => {
        withPM2(() => pm2[action](req.params.id, err => res.json({ ok: !err, error: err ? String(err) : null })), res);
    });
});
apiRouter.delete('/delete/:id', (req, res) => {
    withPM2(() => pm2.delete(req.params.id, err => res.json({ ok: !err, error: err ? String(err) : null })), res);
});

// Global actions: restartAll, stopAll
['restartAll', 'stopAll'].forEach(action => {
    const pm2Action = action.replace('All', '');
    apiRouter.post(`/${action}`, (req, res) => {
        withPM2(() => pm2[pm2Action]('all', e => res.json({ ok: !e, error: e ? String(e) : null })), res);
    });
});

// GET /api/logs/:id - Get logs for a process
apiRouter.get('/logs/:id', (req, res) => {
    withPM2(() => {
        pm2.describe(req.params.id, (err, desc) => {
            if (err || !desc?.length) return res.status(404).json({ error: 'Process not found' });
            const logPath = req.query.type === 'err' ? desc[0].pm2_env.pm_err_log_path : desc[0].pm2_env.pm_out_log_path;
            if (!fs.existsSync(logPath)) return res.type('text/plain').send(`Log for '${req.query.type}' not found.`);

            const stream = fs.createReadStream(logPath, { encoding: 'utf8' });
            res.type('text/plain');
            stream.pipe(res);
        });
    }, res);
});

// GET /api/browse - File browser endpoint
apiRouter.get('/browse', (req, res) => {
    try {
        const reqDir = req.query.dir || '';
        const currentDir = path.resolve(BASE_DIR, reqDir);

        // Security check: ensure the path is within the allowed base directory
        if (!currentDir.startsWith(path.resolve(BASE_DIR))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        const files = entries.filter(e => e.isFile() && e.name.endsWith('.js')).map(e => e.name);

        res.json({ path: reqDir, dirs, files });
    } catch (error) {
        console.error(`Error reading directory ${req.query.dir}:`, error);
        res.status(500).json({ error: `Could not read directory. Verify it exists and you have permissions.` });
    }
});

// Register the API router
app.use('/api', apiRouter);

// --- FALLBACK ROUTE ---
// Serve the index.html for any other route, supporting single-page application routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
app.listen(PORT, () => console.log(`PM2 Admin v3 listening on :${PORT} | Base directory: ${BASE_DIR}`));

