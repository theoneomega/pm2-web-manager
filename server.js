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

const PORT = process.env.PORT || 4747;
const BASE_DIR = process.env.PM2_BASE_DIR || '/home/omega';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
    console.error("Error: ADMIN_PASSWORD y SESSION_SECRET deben estar definidos en el archivo .env");
    process.exit(1);
}

const app = express();

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
    cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 } // 1 día
}));

app.use(express.static(path.join(__dirname, 'public')));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.json({ ok: true, message: 'Login correcto' });
    } else {
        res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ ok: false, error: 'No se pudo cerrar la sesión' });
        }
        res.clearCookie('connect.sid');
        res.json({ ok: true, message: 'Sesión cerrada' });
    });
});


const requireAuth = (req, res, next) => {
    if (req.session.loggedIn) {
        next();
    } else {
        res.status(401).json({ error: 'unauthorized' });
    }
};

let pm2Ready = false;
pm2.connect(err => {
    if (err) {
        console.error("Error conectando a PM2:", err);
        process.exit(2);
    }
    pm2Ready = true;
    console.log('Conectado a PM2 correctamente.');
});
process.on('SIGINT', () => {
    pm2.disconnect();
    process.exit();
});

function withPM2(fn, res) {
    if (!pm2Ready) return res.status(503).json({ error: 'PM2 no está listo' });
    Promise.resolve(fn()).catch(e => {
        console.error("Error en operación PM2:", e);
        res.status(500).json({ error: String(e) });
    });
}

const apiRouter = express.Router();
apiRouter.use(requireAuth);

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

apiRouter.post('/start', (req, res) => {
    withPM2(() => {
        const { script, name, args = [], instances = 1, exec_mode = 'fork' } = req.body || {};
        if (!script || !name) return res.status(400).json({ error: 'script y name son requeridos' });

        const scriptPath = path.resolve(BASE_DIR, script);
        if (!fs.existsSync(scriptPath) || !scriptPath.startsWith(path.resolve(BASE_DIR))) {
            return res.status(403).json({ error: 'Ruta de script no permitida o no existe' });
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

['restart', 'stop'].forEach(action => {
    apiRouter.post(`/${action}/:id`, (req, res) => {
        withPM2(() => pm2[action](req.params.id, err => res.json({ ok: !err, error: err ? String(err) : null })), res);
    });
});
apiRouter.delete('/delete/:id', (req, res) => {
    withPM2(() => pm2.delete(req.params.id, err => res.json({ ok: !err, error: err ? String(err) : null })), res);
});

['restartAll', 'stopAll'].forEach(action => {
    const pm2Action = action.replace('All', '');
    apiRouter.post(`/${action}`, (req, res) => {
        withPM2(() => pm2[pm2Action]('all', e => res.json({ ok: !e, error: e ? String(e) : null })), res);
    });
});

apiRouter.get('/logs/:id', (req, res) => {
    withPM2(() => {
        pm2.describe(req.params.id, (err, desc) => {
            if (err || !desc?.length) return res.status(404).json({ error: 'Proceso no encontrado' });
            const logPath = req.query.type === 'err' ? desc[0].pm2_env.pm_err_log_path : desc[0].pm2_env.pm_out_log_path;
            if (!fs.existsSync(logPath)) return res.type('text/plain').send(`Log de '${req.query.type}' no encontrado.`);

            const stream = fs.createReadStream(logPath, { encoding: 'utf8' });
            res.type('text/plain');
            stream.pipe(res);
        });
    }, res);
});

function findJsFilesRecursive(dir, allFiles = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            findJsFilesRecursive(filePath, allFiles);
        } else if (path.extname(file) === '.js') {
            allFiles.push(path.relative(BASE_DIR, filePath));
        }
    });
    return allFiles;
}
apiRouter.get('/browse', (req, res) => {
    try {
        const reqDir = req.query.dir || '';
        const currentDir = path.resolve(BASE_DIR, reqDir);

        if (!currentDir.startsWith(path.resolve(BASE_DIR))) {
            return res.status(403).json({ error: 'Acceso denegado' });
        }

        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        const files = entries.filter(e => e.isFile() && e.name.endsWith('.js')).map(e => e.name);

        res.json({ path: reqDir, dirs, files });
    } catch (error) {
        console.error(`Error leyendo directorio ${req.query.dir}:`, error);
        res.status(500).json({ error: `No se pudo leer el directorio. Verifica que exista y tengas permisos.` });
    }
});


app.use('/api', apiRouter);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(PORT, () => console.log(`PM2 Admin v3 escuchando en :${PORT} | Directorio base: ${BASE_DIR}`));

