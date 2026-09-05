require('dotenv').config();

const { validateEnv } = require('./utils/validateEnv');
validateEnv(); // fail fast with a clear message instead of a cryptic AWS SDK error later

const express = require('express');
const helmet = require('helmet');
const path = require('node:path');

const filesRouter = require('./routes/files');

const app = express();

app.use(
  helmet({
    // Web Crypto + fetch-to-S3 needs a slightly relaxed default-src; keep
    // everything else locked down.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'https://*.amazonaws.com'],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', filesRouter);

app.get('/', (_req, res) => res.render('index'));
app.get('/f/:id', (req, res) => res.render('share', { fileId: req.params.id }));

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Secure file sharing server running on http://localhost:${PORT}`));
