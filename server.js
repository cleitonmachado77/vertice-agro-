const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const db = require('./database');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEFAULT_GESTATION_DAYS = 282;

function formatDisplayDate(value) {
  if (!value) return '—';
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value;
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('Configure SESSION_SECRET antes de iniciar em producao.');
}

app.set('view engine', 'ejs');
app.set('views', `${__dirname}/views`);
app.locals.formatDate = formatDisplayDate;
app.locals.defaultGestationDays = DEFAULT_GESTATION_DAYS;
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com']
    }
  }
}));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(`${__dirname}/public`));
app.use(async (req, res, next) => {
  try {
    await db.ready;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(session({
  store: new PgSession({
    pool: db.pool,
    tableName: 'app_session',
    createTableIfMissing: false,
    pruneSessionInterval: false
  }),
  name: 'campobase.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.user = null;
  next();
});

const moduleInfo = {
  admin: { title: 'Administrador', subtitle: 'Gestão do sistema', roles: ['Administrador', 'Gestor'] },
  agricultura: { title: 'Atividades Agrícolas', subtitle: 'Produção agrícola', roles: ['Administrador', 'Gestor', 'Produtor'] },
  pecuaria: { title: 'Pecuária de Leite', subtitle: 'Rebanho e produção leiteira', roles: ['Administrador', 'Gestor', 'Produtor'] }
};

function producerScope(user, producerAlias = 'pr') {
  if (user.Perfil === 'Administrador') return { sql: '1 = 1', params: [] };
  if (user.Perfil === 'Gestor') {
    return {
      sql: `${producerAlias}.Ativo = 1 AND EXISTS (SELECT 1 FROM Usuario pu WHERE pu.idUsuario = ${producerAlias}.Usuario_idUsuario AND pu.Situacao = 'Ativo') AND ${producerAlias}.CooperativaAssociacao_idCooperativaAssociacao IN (SELECT uc.CooperativaAssociacao_idCooperativaAssociacao FROM UsuarioCooperativaAssociacao uc JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = uc.CooperativaAssociacao_idCooperativaAssociacao WHERE uc.Usuario_idUsuario = ? AND ca.Ativo = 1)`,
      params: [user.idUsuario]
    };
  }
  return {
    sql: `${producerAlias}.Usuario_idUsuario = ? AND ${producerAlias}.Ativo = 1 AND EXISTS (SELECT 1 FROM Usuario pu WHERE pu.idUsuario = ${producerAlias}.Usuario_idUsuario AND pu.Situacao = 'Ativo') AND EXISTS (SELECT 1 FROM CooperativaAssociacao ca WHERE ca.idCooperativaAssociacao = ${producerAlias}.CooperativaAssociacao_idCooperativaAssociacao AND ca.Ativo = 1)`,
    params: [user.idUsuario]
  };
}

async function getModuleMetrics(user, slug) {
  const scope = producerScope(user);
  if (slug === 'admin' && user.Perfil === 'Administrador') {
    return [
      { label: 'Usuários ativos', value: (await db.prepare("SELECT COUNT(*) AS value FROM Usuario WHERE Situacao = 'Ativo'").get()).value },
      { label: 'Associações ativas', value: (await db.prepare('SELECT COUNT(*) AS value FROM CooperativaAssociacao WHERE Ativo = 1').get()).value },
      { label: 'Produtores', value: (await db.prepare('SELECT COUNT(*) AS value FROM Produtor').get()).value },
      { label: 'Propriedades', value: (await db.prepare('SELECT COUNT(*) AS value FROM Propriedade').get()).value }
    ];
  }

  if (slug === 'admin') {
    return [
      { label: 'Produtores vinculados', value: (await db.prepare(`SELECT COUNT(*) AS value FROM Produtor pr WHERE ${scope.sql}`).get(...scope.params)).value },
      { label: 'Propriedades', value: (await db.prepare(`SELECT COUNT(*) AS value FROM Propriedade p JOIN Produtor pr ON pr.idProdutor = p.Produtor_idProdutor WHERE ${scope.sql}`).get(...scope.params)).value }
    ];
  }

  if (slug === 'agricultura') {
    const productionScope = producerScope(user, 'pr');
    const productionJoin = `FROM Producao p JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor WHERE ${productionScope.sql}`;
    return [
      { label: 'Planejamentos', value: (await db.prepare(`SELECT COUNT(*) AS value ${productionJoin} AND p.Situacao = 'Planejada'`).get(...productionScope.params)).value },
      { label: 'Quantidade prevista', value: (await db.prepare(`SELECT COALESCE(SUM(p.Previsao), 0) AS value ${productionJoin}`).get(...productionScope.params)).value },
      { label: 'Entregas registradas', value: (await db.prepare(`SELECT COUNT(*) AS value FROM Entrega e JOIN Producao p ON p.IdProducao = e.Producao_idProducao JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor WHERE ${productionScope.sql}`).get(...productionScope.params)).value }
    ];
  }

  const livestockScope = producerScope(user, 'pr');
  const animalJoin = `FROM Animal a JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = a.AtividadePropriedade_idAtividadePropriedade JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor WHERE ${livestockScope.sql}`;
  return [
    { label: 'Animais no rebanho', value: (await db.prepare(`SELECT COUNT(*) AS value ${animalJoin} AND a.PertenceRebanho = 1`).get(...livestockScope.params)).value },
    { label: 'Lactações', value: (await db.prepare(`SELECT COUNT(*) AS value FROM Lactacoes l JOIN Animal a ON a.idAnimal = l.Animal_idAnimal JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = a.AtividadePropriedade_idAtividadePropriedade JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor WHERE ${livestockScope.sql}`).get(...livestockScope.params)).value },
    { label: 'Lançamentos de leite', value: (await db.prepare(`SELECT COUNT(*) AS value FROM Lancamentos la JOIN Lactacoes l ON l.idLactacoes = la.Lactacoes_idLactacoes JOIN Animal a ON a.idAnimal = l.Animal_idAnimal JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = a.AtividadePropriedade_idAtividadePropriedade JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor WHERE ${livestockScope.sql}`).get(...livestockScope.params)).value }
  ];
}

async function getProductionForecastChart(user, requestedProductId) {
  const scope = producerScope(user, 'pr');
  const from = `
    FROM Producao p
    JOIN Produto prod ON prod.idProduto = p.Produto_idProduto
    JOIN Atividade a ON a.idAtividade = prod.Atividade_idAtividade
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
  `;
  const conditions = [
    scope.sql,
    'a.Agricultura = 1',
    "p.Situacao = 'Planejada'",
    'p.PrevisaoProducao IS NOT NULL',
    'p.Previsao IS NOT NULL'
  ];
  const products = (await db.prepare(`
    SELECT DISTINCT prod.idProduto, prod.Nome, u.Sigla AS UnidadeSigla
    ${from}
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    WHERE ${conditions.join(' AND ')}
    ORDER BY prod.Nome COLLATE NOCASE
  `).all(...scope.params));
  const requestedId = Number(requestedProductId);
  const productId = Number.isInteger(requestedId) && products.some((product) => product.idProduto === requestedId)
    ? requestedId
    : null;
  const dataConditions = [...conditions];
  const dataParams = [...scope.params];
  if (productId) {
    dataConditions.push('prod.idProduto = ?');
    dataParams.push(productId);
  }
  const rows = (await db.prepare(`
    SELECT prod.idProduto, prod.Nome AS ProdutoNome, u.Sigla AS UnidadeSigla,
      p.PrevisaoProducao AS DataPrevisao, SUM(p.Previsao) AS Quantidade
    ${from}
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    WHERE ${dataConditions.join(' AND ')}
    GROUP BY prod.idProduto, prod.Nome, u.Sigla, p.PrevisaoProducao
    ORDER BY p.PrevisaoProducao, prod.Nome COLLATE NOCASE
  `).all(...dataParams));
  if (!rows.length) return { products, productId, hasData: false, charts: [] };

  const rowsByUnit = new Map();
  rows.forEach((row) => {
    if (!rowsByUnit.has(row.UnidadeSigla)) rowsByUnit.set(row.UnidadeSigla, []);
    rowsByUnit.get(row.UnidadeSigla).push(row);
  });
  const charts = [...rowsByUnit.entries()].map(([unit, unitRows]) => {
    const dates = [...new Set(unitRows.map((row) => row.DataPrevisao))];
    const width = 900;
    const height = 350;
    const plot = { left: 72, right: 884, top: 24, bottom: 294 };
    const timestamps = dates.map((date) => Date.parse(`${date}T00:00:00Z`));
    const firstTimestamp = Math.min(...timestamps);
    const lastTimestamp = Math.max(...timestamps);
    const xFor = (date) => firstTimestamp === lastTimestamp
      ? (plot.left + plot.right) / 2
      : plot.left + ((Date.parse(`${date}T00:00:00Z`) - firstTimestamp) / (lastTimestamp - firstTimestamp)) * (plot.right - plot.left);
    const maxQuantity = Math.max(...unitRows.map((row) => Number(row.Quantidade)));
    const rawStep = maxQuantity / 4 || 1;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalizedStep = rawStep / magnitude;
    const stepScale = normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
    const yStep = stepScale * magnitude;
    const yMax = yStep * 4;
    const yFor = (value) => plot.bottom - (Number(value) / yMax) * (plot.bottom - plot.top);
    const yTicks = Array.from({ length: 5 }, (_, tickIndex) => {
      const value = yStep * tickIndex;
      return { y: yFor(value), label: value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) };
    });
    const dateTickIndexes = dates.length <= 6
      ? dates.map((_, dateIndex) => dateIndex)
      : [...new Set(Array.from({ length: 6 }, (_, tickIndex) => Math.round(tickIndex * (dates.length - 1) / 5)))];
    const xTicks = dateTickIndexes.map((dateIndex) => ({
      x: xFor(dates[dateIndex]),
      label: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${dates[dateIndex]}T00:00:00Z`))
    }));
    const seriesRows = new Map();
    unitRows.forEach((row) => {
      if (!seriesRows.has(row.idProduto)) seriesRows.set(row.idProduto, { name: row.ProdutoNome, points: [] });
      seriesRows.get(row.idProduto).points.push({
        x: xFor(row.DataPrevisao),
        y: yFor(row.Quantidade),
        date: formatDisplayDate(row.DataPrevisao),
        label: Number(row.Quantidade).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
      });
    });
    const series = [...seriesRows.entries()].map(([seriesProductId, seriesData], seriesIndex) => ({
      id: seriesProductId,
      name: seriesData.name,
      unit,
      colorIndex: seriesIndex % 6,
      points: seriesData.points,
      path: seriesData.points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
    }));
    return { unit, width, height, plot, series, yTicks, xTicks };
  });
  return { products, productId, hasData: true, charts };
}

async function getMilkProductionChart(user, requestedPropertyId, requestedAnimalId) {
  const scope = producerScope(user, 'pr');
  const properties = (await db.prepare(`
    SELECT DISTINCT prop.idPropriedade, prop.Nome, pr.Nome AS ProdutorNome
    FROM Propriedade prop
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN AtividadePropriedade ap ON ap.Propriedade_idPropriedade = prop.idPropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    WHERE ${scope.sql} AND a.Pecuaria = 1 AND a.Ativo = 1 AND ap.Ativo = 1 AND prop.Ativo = 1
    ORDER BY prop.Nome COLLATE NOCASE
  `).all(...scope.params));
  const requestedId = Number(requestedPropertyId);
  const propertyId = Number.isInteger(requestedId) && properties.some((property) => property.idPropriedade === requestedId)
    ? requestedId
    : null;
  const animalConditions = [scope.sql, 'a.Pecuaria = 1'];
  const animalParams = [...scope.params];
  if (propertyId) {
    animalConditions.push('prop.idPropriedade = ?');
    animalParams.push(propertyId);
  }
  const animals = (await db.prepare(`
    SELECT DISTINCT animal.idAnimal, animal.Brinco, prop.idPropriedade, prop.Nome AS PropriedadeNome
    FROM Animal animal
    JOIN Lactacoes lact ON lact.Animal_idAnimal = animal.idAnimal
    JOIN Lancamentos milk ON milk.Lactacoes_idLactacoes = lact.idLactacoes
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE ${animalConditions.join(' AND ')} AND milk.DataLancamento >= lact.Inicio
      AND (lact.Termino IS NULL OR milk.DataLancamento <= lact.Termino)
    ORDER BY animal.Brinco COLLATE NOCASE
  `).all(...animalParams));
  const requestedCowId = Number(requestedAnimalId);
  const animalId = Number.isInteger(requestedCowId) && animals.some((animal) => animal.idAnimal === requestedCowId)
    ? requestedCowId
    : null;
  const selectedAnimal = animals.find((animal) => animal.idAnimal === animalId) || null;
  const conditions = [scope.sql, 'a.Pecuaria = 1', 'milk.DataLancamento >= lact.Inicio', '(lact.Termino IS NULL OR milk.DataLancamento <= lact.Termino)'];
  const params = [...scope.params];
  if (propertyId) {
    conditions.push('prop.idPropriedade = ?');
    params.push(propertyId);
  }
  if (animalId) {
    conditions.push('animal.idAnimal = ?');
    params.push(animalId);
  }
  const rows = (await db.prepare(`
    SELECT milk.DataLancamento AS DataPesagem,
      AVG(milk.Quantidade) AS MediaLitros, COUNT(DISTINCT animal.idAnimal) AS Animais
    FROM Lancamentos milk
    JOIN Lactacoes lact ON lact.idLactacoes = milk.Lactacoes_idLactacoes
    JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE ${conditions.join(' AND ')}
    GROUP BY milk.DataLancamento
    ORDER BY milk.DataLancamento
  `).all(...params));
  if (!rows.length) return { properties, animals, propertyId, animalId, hasData: false, chart: null };

  const dates = rows.map((row) => row.DataPesagem);
  const dateNumbers = dates.map((date) => Date.parse(`${date}T00:00:00Z`) / 86400000);
  const plot = { left: 72, right: 884, top: 24, bottom: 294 };
  const firstDate = Math.min(...dateNumbers);
  const lastDate = Math.max(...dateNumbers);
  const xFor = (dateNumber) => firstDate === lastDate
    ? (plot.left + plot.right) / 2
    : plot.left + ((dateNumber - firstDate) / (lastDate - firstDate)) * (plot.right - plot.left);
  const maxQuantity = Math.max(...rows.map((row) => Number(row.MediaLitros)));
  const rawStep = maxQuantity / 4 || 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalizedStep = rawStep / magnitude;
  const stepScale = normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
  const yStep = stepScale * magnitude;
  const yMax = yStep * 4;
  const yFor = (value) => plot.bottom - (Number(value) / yMax) * (plot.bottom - plot.top);
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = yStep * index;
    return { y: yFor(value), label: value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) };
  });
  const dateTickIndexes = rows.length <= 6
    ? rows.map((_, index) => index)
    : [...new Set(Array.from({ length: 6 }, (_, index) => Math.round(index * (rows.length - 1) / 5)))];
  const xTicks = dateTickIndexes.map((index) => ({ x: xFor(dateNumbers[index]), label: formatDisplayDate(dates[index]) }));
  const seriesData = rows.map((row) => ({
    x: xFor(Date.parse(`${row.DataPesagem}T00:00:00Z`) / 86400000),
    y: yFor(row.MediaLitros),
    date: formatDisplayDate(row.DataPesagem),
    label: Number(row.MediaLitros).toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
    animals: row.Animais
  }));
  const seriesName = selectedAnimal
    ? `Vaca ${selectedAnimal.Brinco || selectedAnimal.idAnimal}`
    : propertyId ? 'Média da propriedade' : 'Média das propriedades';
  const series = [{
    id: animalId || propertyId || 'all',
    name: seriesName,
    colorIndex: 0,
    points: seriesData,
    path: seriesData.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
  }];
  return { properties, animals, propertyId, animalId, hasData: true, chart: { width: 900, height: 350, plot, series, yTicks, xTicks } };
}

async function hasAdministrator() {
  return Boolean((await db.prepare("SELECT 1 FROM Usuario WHERE Perfil = 'Administrador' LIMIT 1").get()));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex || expectedHex.length !== 128) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

function verifyCsrf(req, res, next) {
  const submitted = String(req.body._csrf || '');
  const expected = String(req.session.csrfToken || '');
  const submittedBuffer = Buffer.from(submitted);
  const expectedBuffer = Buffer.from(expected);
  if (submittedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(submittedBuffer, expectedBuffer)) {
    return res.status(403).render('error', { pageTitle: 'Acesso recusado', message: 'A sessão expirou. Atualize a página e tente novamente.' });
  }
  next();
}

async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = (await db.prepare('SELECT idUsuario, Nome, Login, Perfil, Situacao FROM Usuario WHERE idUsuario = ?').get(req.session.userId));
  if (!user || user.Situacao !== 'Ativo') {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }
  req.user = user;
  res.locals.user = user;
  next();
}

function requireAdministrator(req, res, next) {
  if (req.user.Perfil !== 'Administrador') {
    return res.status(403).render('error', { pageTitle: 'Acesso restrito', message: 'Somente Administradores podem gerenciar usuários.' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', async (req, res) => {
  if (!(await hasAdministrator())) return res.redirect('/setup');
  return res.redirect(req.session.userId ? '/modulos' : '/login');
});

app.get('/setup', async (req, res) => {
  if ((await hasAdministrator())) return res.redirect('/login');
  res.render('setup', { pageTitle: 'Criar administrador', error: null });
});

app.post('/setup', verifyCsrf, async (req, res) => {
  if ((await hasAdministrator())) return res.redirect('/login');
  const name = String(req.body.name || '').trim();
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '');
  const confirmation = String(req.body.confirmation || '');

  if (name.length < 2 || name.length > 120 || login.length < 3 || login.length > 50) {
    return res.status(400).render('setup', { pageTitle: 'Criar administrador', error: 'Informe nome e usuário válidos.' });
  }
  if (password.length < 12 || password !== confirmation) {
    return res.status(400).render('setup', { pageTitle: 'Criar administrador', error: 'A senha deve ter ao menos 12 caracteres e as confirmações precisam coincidir.' });
  }

  try {
    const createAdmin = db.transaction(async () => {
      if ((await hasAdministrator())) throw new Error('Administrador já configurado.');
      (await db.prepare('INSERT INTO Usuario (Nome, Login, Senha, Situacao, Perfil) VALUES (?, ?, ?, ?, ?)')
        .run(name, login, hashPassword(password), 'Ativo', 'Administrador'));
    });
    (await createAdmin.immediate());
    return req.session.regenerate(async (error) => {
      if (error) return res.status(500).render('error', { pageTitle: 'Erro', message: 'Não foi possível iniciar a sessão.' });
      req.session.userId = (await db.prepare('SELECT idUsuario FROM Usuario WHERE Login = ?').get(login)).idUsuario;
      return res.redirect('/modulos');
    });
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este usuário já está em uso.' : 'Não foi possível criar o administrador.';
    return res.status(400).render('setup', { pageTitle: 'Criar administrador', error: message });
  }
});

app.get('/login', async (req, res) => {
  if (!(await hasAdministrator())) return res.redirect('/setup');
  if (req.session.userId) return res.redirect('/modulos');
  res.render('login', { pageTitle: 'Entrar', error: null });
});

app.post('/login', verifyCsrf, async (req, res) => {
  if (!(await hasAdministrator())) return res.redirect('/setup');
  const login = String(req.body.login || '').trim();
  const password = String(req.body.password || '');
  const user = (await db.prepare('SELECT idUsuario, Senha, Situacao FROM Usuario WHERE Login = ? COLLATE NOCASE').get(login));
  if (!user || user.Situacao !== 'Ativo' || !verifyPassword(password, user.Senha)) {
    return res.status(401).render('login', { pageTitle: 'Entrar', error: 'Usuário ou senha inválidos.' });
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).render('error', { pageTitle: 'Erro', message: 'Não foi possível iniciar a sessão.' });
    req.session.userId = user.idUsuario;
    res.redirect('/modulos');
  });
});

app.post('/logout', requireAuth, verifyCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

async function renderUsers(res, error = null, status = 200) {
  const users = (await db.prepare(`
    SELECT u.idUsuario, u.Nome, u.Login, u.Perfil, u.Situacao,
      COALESCE(
        (SELECT uc.CooperativaAssociacao_idCooperativaAssociacao FROM UsuarioCooperativaAssociacao uc WHERE uc.Usuario_idUsuario = u.idUsuario LIMIT 1),
        (SELECT p.CooperativaAssociacao_idCooperativaAssociacao FROM Produtor p WHERE p.Usuario_idUsuario = u.idUsuario LIMIT 1)
      ) AS AssociationID
    FROM Usuario u
    ORDER BY u.Nome COLLATE NOCASE
  `).all());
  const associations = (await db.prepare('SELECT idCooperativaAssociacao, Nome, Ativo FROM CooperativaAssociacao ORDER BY Nome COLLATE NOCASE').all());
  return res.status(status).render('users', { pageTitle: 'Usuários', users, associations, error });
}

async function validateUserFields(body, allowInactiveAssociationId = null) {
  const name = String(body.name || '').trim();
  const login = String(body.login || '').trim();
  const profile = String(body.profile || '');
  const associationId = body.associationId ? Number(body.associationId) : null;
  if (name.length < 2 || name.length > 120 || login.length < 3 || login.length > 50) {
    return { error: 'Informe nome e usuário válidos.' };
  }
  if (!['Administrador', 'Gestor', 'Produtor'].includes(profile)) {
    return { error: 'Selecione um perfil válido.' };
  }
  if (['Gestor', 'Produtor'].includes(profile)) {
    const association = Number.isInteger(associationId)
      ? (await db.prepare('SELECT Ativo FROM CooperativaAssociacao WHERE idCooperativaAssociacao = ?').get(associationId))
      : null;
    if (!association || (association.Ativo !== 1 && associationId !== allowInactiveAssociationId)) {
      return { error: 'Selecione uma associação para este perfil.' };
    }
  }
  return { name, login, profile, associationId };
}

app.get('/admin/usuarios', requireAuth, requireAdministrator, async (req, res) => (await renderUsers(res)));

app.post('/admin/usuarios', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const fields = (await validateUserFields(req.body));
  const password = String(req.body.password || '');
  if (fields.error) return (await renderUsers(res, fields.error, 400));
  if (password.length < 12) return (await renderUsers(res, 'A senha deve ter ao menos 12 caracteres.', 400));

  try {
    const createUser = db.transaction(async () => {
      const result = (await db.prepare('INSERT INTO Usuario (Nome, Login, Senha, Situacao, Perfil) VALUES (?, ?, ?, ?, ?)')
        .run(fields.name, fields.login, hashPassword(password), 'Ativo', fields.profile));
      if (fields.profile === 'Gestor') {
        (await db.prepare('INSERT INTO UsuarioCooperativaAssociacao (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao) VALUES (?, ?)')
          .run(result.lastInsertRowid, fields.associationId));
      }
      if (fields.profile === 'Produtor') {
        (await db.prepare('INSERT INTO Produtor (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao, Nome) VALUES (?, ?, ?)')
          .run(result.lastInsertRowid, fields.associationId, fields.name));
      }
    });
    (await createUser.immediate());
    return res.redirect('/admin/usuarios');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este usuário já está em uso.' : 'Não foi possível criar o usuário.';
    return (await renderUsers(res, message, 400));
  }
});

app.post('/admin/usuarios/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const userId = Number(req.params.id);
  const current = (await db.prepare(`
    SELECT u.idUsuario, u.Perfil, u.Situacao,
      COALESCE(
        (SELECT uc.CooperativaAssociacao_idCooperativaAssociacao FROM UsuarioCooperativaAssociacao uc WHERE uc.Usuario_idUsuario = u.idUsuario LIMIT 1),
        (SELECT p.CooperativaAssociacao_idCooperativaAssociacao FROM Produtor p WHERE p.Usuario_idUsuario = u.idUsuario LIMIT 1)
      ) AS AssociationID
    FROM Usuario u WHERE u.idUsuario = ?
  `).get(userId));
  const fields = (await validateUserFields(req.body, current?.AssociationID ?? null));
  const status = String(req.body.status || '');
  const password = String(req.body.password || '');
  if (!current) return (await renderUsers(res, 'Usuário não encontrado.', 404));
  if (fields.error) return (await renderUsers(res, fields.error, 400));
  if (!['Ativo', 'Inativo'].includes(status)) return (await renderUsers(res, 'Selecione uma situação válida.', 400));
  if (password && password.length < 12) return (await renderUsers(res, 'A nova senha deve ter ao menos 12 caracteres.', 400));
  if (userId === req.user.idUsuario && (status !== 'Ativo' || fields.profile !== 'Administrador')) {
    return (await renderUsers(res, 'Não é permitido alterar o próprio perfil ou inativar a própria conta.', 400));
  }

  try {
    const updateUser = db.transaction(async () => {
      if (current.Perfil === 'Administrador' && current.Situacao === 'Ativo' && (status !== 'Ativo' || fields.profile !== 'Administrador')) {
        const activeAdmins = (await db.prepare("SELECT COUNT(*) AS total FROM Usuario WHERE Perfil = 'Administrador' AND Situacao = 'Ativo'").get()).total;
        if (activeAdmins <= 1) throw new Error('LAST_ADMIN');
      }
      if (password) {
        (await db.prepare('UPDATE Usuario SET Nome = ?, Login = ?, Senha = ?, Situacao = ?, Perfil = ? WHERE idUsuario = ?')
          .run(fields.name, fields.login, hashPassword(password), status, fields.profile, userId));
      } else {
        (await db.prepare('UPDATE Usuario SET Nome = ?, Login = ?, Situacao = ?, Perfil = ? WHERE idUsuario = ?')
          .run(fields.name, fields.login, status, fields.profile, userId));
      }

      (await db.prepare('DELETE FROM UsuarioCooperativaAssociacao WHERE Usuario_idUsuario = ?').run(userId));
      if (fields.profile === 'Gestor') {
        (await db.prepare('INSERT INTO UsuarioCooperativaAssociacao (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao) VALUES (?, ?)')
          .run(userId, fields.associationId));
      }
      if (fields.profile === 'Produtor') {
        const producer = (await db.prepare('SELECT idProdutor FROM Produtor WHERE Usuario_idUsuario = ?').get(userId));
        if (producer) {
          (await db.prepare('UPDATE Produtor SET Nome = ?, CooperativaAssociacao_idCooperativaAssociacao = ? WHERE Usuario_idUsuario = ?')
            .run(fields.name, fields.associationId, userId));
        } else {
          (await db.prepare('INSERT INTO Produtor (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao, Nome) VALUES (?, ?, ?)')
            .run(userId, fields.associationId, fields.name));
        }
      }
    });
    (await updateUser.immediate());
    return res.redirect('/admin/usuarios');
  } catch (error) {
    const message = error.message === 'LAST_ADMIN'
      ? 'O sistema precisa manter ao menos um Administrador ativo.'
      : error.code === 'SQLITE_CONSTRAINT_UNIQUE'
        ? 'Este usuário já está em uso.'
        : 'Não foi possível atualizar o usuário.';
    return (await renderUsers(res, message, 400));
  }
});

app.post('/admin/usuarios/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const userId = Number(req.params.id);
  if (userId === req.user.idUsuario) return (await renderUsers(res, 'Não é possível excluir a própria conta.', 400));
  try {
    const deleteUser = db.transaction(async () => {
      const target = (await db.prepare('SELECT Perfil, Situacao FROM Usuario WHERE idUsuario = ?').get(userId));
      if (!target) throw new Error('NOT_FOUND');
      if (target.Perfil === 'Administrador' && target.Situacao === 'Ativo') {
        const activeAdmins = (await db.prepare("SELECT COUNT(*) AS total FROM Usuario WHERE Perfil = 'Administrador' AND Situacao = 'Ativo'").get()).total;
        if (activeAdmins <= 1) throw new Error('LAST_ADMIN');
      }
      (await db.prepare('DELETE FROM UsuarioCooperativaAssociacao WHERE Usuario_idUsuario = ?').run(userId));
      (await db.prepare('DELETE FROM Produtor WHERE Usuario_idUsuario = ?').run(userId));
      (await db.prepare('DELETE FROM Usuario WHERE idUsuario = ?').run(userId));
    });
    (await deleteUser.immediate());
    return res.redirect('/admin/usuarios');
  } catch (error) {
    const message = error.message === 'LAST_ADMIN'
      ? 'O sistema precisa manter ao menos um Administrador ativo.'
      : error.message === 'NOT_FOUND'
        ? 'Usuário não encontrado.'
        : 'Este usuário possui dados vinculados e não pode ser excluído. Inative a conta para preservar o histórico.';
    return (await renderUsers(res, message, 400));
  }
});

async function producerAssociationOptions(user) {
  if (user.Perfil === 'Administrador') {
    return (await db.prepare('SELECT idCooperativaAssociacao, Nome, Ativo FROM CooperativaAssociacao ORDER BY Nome COLLATE NOCASE').all());
  }
  return (await db.prepare(`
    SELECT ca.idCooperativaAssociacao, ca.Nome, ca.Ativo
    FROM UsuarioCooperativaAssociacao uc
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = uc.CooperativaAssociacao_idCooperativaAssociacao
    WHERE uc.Usuario_idUsuario = ? AND ca.Ativo = 1
    ORDER BY ca.Nome COLLATE NOCASE
  `).all(user.idUsuario));
}

async function producerAssociationAllowed(user, associationId, allowCurrentInactive = false) {
  const association = (await db.prepare('SELECT Ativo FROM CooperativaAssociacao WHERE idCooperativaAssociacao = ?').get(associationId));
  if (!association || (association.Ativo !== 1 && !allowCurrentInactive)) return false;
  if (user.Perfil === 'Administrador') return true;
  return Boolean((await db.prepare(`
    SELECT 1 FROM UsuarioCooperativaAssociacao
    WHERE Usuario_idUsuario = ? AND CooperativaAssociacao_idCooperativaAssociacao = ?
  `).get(user.idUsuario, associationId)));
}

async function renderProducers(res, user, error = null, status = 200) {
  const associations = (await producerAssociationOptions(user));
  const associationIds = associations.map((association) => association.idCooperativaAssociacao);
  let producers = [];
  if (user.Perfil === 'Administrador') {
    producers = (await db.prepare(`
      SELECT p.idProdutor, p.Usuario_idUsuario, p.CooperativaAssociacao_idCooperativaAssociacao, p.Nome, p.Fone, p.Email,
        p.Ativo AND u.Situacao = 'Ativo' AS Ativo, u.Login, ca.Nome AS Associacao
      FROM Produtor p JOIN Usuario u ON u.idUsuario = p.Usuario_idUsuario
      JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = p.CooperativaAssociacao_idCooperativaAssociacao
      ORDER BY p.Nome COLLATE NOCASE
    `).all());
  } else if (associationIds.length) {
    const placeholders = associationIds.map(() => '?').join(', ');
    producers = (await db.prepare(`
      SELECT p.idProdutor, p.Usuario_idUsuario, p.CooperativaAssociacao_idCooperativaAssociacao, p.Nome, p.Fone, p.Email,
        p.Ativo AND u.Situacao = 'Ativo' AS Ativo, u.Login, ca.Nome AS Associacao
      FROM Produtor p JOIN Usuario u ON u.idUsuario = p.Usuario_idUsuario
      JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = p.CooperativaAssociacao_idCooperativaAssociacao
      WHERE p.CooperativaAssociacao_idCooperativaAssociacao IN (${placeholders})
      ORDER BY p.Nome COLLATE NOCASE
    `).all(...associationIds));
  }
  return res.status(status).render('producers', { pageTitle: 'Produtores', producers, associations, error });
}

async function validateProducerFields(body, user, allowCurrentAssociationId = null) {
  const fields = {
    name: String(body.name || '').trim(),
    login: String(body.login || '').trim(),
    associationId: Number(body.associationId),
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim()
  };
  if (fields.name.length < 2 || fields.name.length > 120) return { error: 'Informe um nome válido para o Produtor.' };
  if (fields.login.length < 3 || fields.login.length > 50) return { error: 'Informe um usuário entre 3 e 50 caracteres.' };
  if (!Number.isInteger(fields.associationId) || !(await producerAssociationAllowed(user, fields.associationId, fields.associationId === allowCurrentAssociationId))) {
    return { error: 'Selecione uma associação ativa que esteja disponível para você.' };
  }
  if (fields.phone.length > 40) return { error: 'O telefone excede 40 caracteres.' };
  if (fields.email.length > 150 || (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email))) {
    return { error: 'Informe um e-mail válido de até 150 caracteres.' };
  }
  return fields;
}

app.get('/admin/produtores', requireAuth, requireCatalogManager, async (req, res) => (await renderProducers(res, req.user)));

app.post('/admin/produtores', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const fields = (await validateProducerFields(req.body, req.user));
  const password = String(req.body.password || '');
  if (fields.error) return (await renderProducers(res, req.user, fields.error, 400));
  if (password.length < 12) return (await renderProducers(res, req.user, 'A senha deve ter ao menos 12 caracteres.', 400));
  try {
    const createProducer = db.transaction(async () => {
      const userResult = (await db.prepare('INSERT INTO Usuario (Nome, Login, Senha, Situacao, Perfil) VALUES (?, ?, ?, ?, ?)')
        .run(fields.name, fields.login, hashPassword(password), 'Ativo', 'Produtor'));
      (await db.prepare(`
        INSERT INTO Produtor (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao, Nome, Fone, Email)
        VALUES (?, ?, ?, ?, ?)
      `).run(userResult.lastInsertRowid, fields.associationId, fields.name, fields.phone || null, fields.email || null));
    });
    (await createProducer.immediate());
    return res.redirect('/admin/produtores');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este usuário já está em uso.' : 'Não foi possível criar o Produtor.';
    return (await renderProducers(res, req.user, message, 400));
  }
});

app.post('/admin/produtores/:id/atualizar', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const producerId = Number(req.params.id);
  const current = (await db.prepare(`
    SELECT p.idProdutor, p.Usuario_idUsuario, p.CooperativaAssociacao_idCooperativaAssociacao
    FROM Produtor p WHERE p.idProdutor = ?
  `).get(producerId));
  if (!current || !(await producerAssociationAllowed(req.user, current.CooperativaAssociacao_idCooperativaAssociacao, true))) {
    return (await renderProducers(res, req.user, 'Produtor não encontrado.', 404));
  }
  const fields = (await validateProducerFields(req.body, req.user, current.CooperativaAssociacao_idCooperativaAssociacao));
  const active = String(req.body.active || '');
  const password = String(req.body.password || '');
  if (fields.error) return (await renderProducers(res, req.user, fields.error, 400));
  if (!['0', '1'].includes(active)) return (await renderProducers(res, req.user, 'Selecione uma situação válida.', 400));
  if (password && password.length < 12) return (await renderProducers(res, req.user, 'A nova senha deve ter ao menos 12 caracteres.', 400));
  try {
    const updateProducer = db.transaction(async () => {
      (await db.prepare(`
        UPDATE Produtor SET CooperativaAssociacao_idCooperativaAssociacao = ?, Nome = ?, Fone = ?, Email = ?, Ativo = ?
        WHERE idProdutor = ?
      `).run(fields.associationId, fields.name, fields.phone || null, fields.email || null, Number(active), producerId));
      if (password) {
        (await db.prepare('UPDATE Usuario SET Nome = ?, Login = ?, Situacao = ?, Senha = ? WHERE idUsuario = ?')
          .run(fields.name, fields.login, active === '1' ? 'Ativo' : 'Inativo', hashPassword(password), current.Usuario_idUsuario));
      } else {
        (await db.prepare('UPDATE Usuario SET Nome = ?, Login = ?, Situacao = ? WHERE idUsuario = ?')
          .run(fields.name, fields.login, active === '1' ? 'Ativo' : 'Inativo', current.Usuario_idUsuario));
      }
    });
    (await updateProducer.immediate());
    return res.redirect('/admin/produtores');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este usuário já está em uso.' : 'Não foi possível atualizar o Produtor.';
    return (await renderProducers(res, req.user, message, 400));
  }
});

app.post('/admin/produtores/:id/excluir', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const producerId = Number(req.params.id);
  const current = (await db.prepare(`
    SELECT p.Usuario_idUsuario, p.CooperativaAssociacao_idCooperativaAssociacao
    FROM Produtor p WHERE p.idProdutor = ?
  `).get(producerId));
  if (!current || !(await producerAssociationAllowed(req.user, current.CooperativaAssociacao_idCooperativaAssociacao, true))) {
    return (await renderProducers(res, req.user, 'Produtor não encontrado.', 404));
  }
  try {
    const deleteProducer = db.transaction(async () => {
      (await db.prepare('DELETE FROM Produtor WHERE idProdutor = ?').run(producerId));
      (await db.prepare('DELETE FROM Usuario WHERE idUsuario = ?').run(current.Usuario_idUsuario));
    });
    (await deleteProducer.immediate());
    return res.redirect('/admin/produtores');
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'Este Produtor possui propriedades ou registros vinculados. Inative-o para preservar o histórico.'
      : 'Não foi possível excluir o Produtor.';
    return (await renderProducers(res, req.user, message, 400));
  }
});

async function renderAssociations(res, error = null, status = 200) {
  const associations = (await db.prepare(`
    SELECT ca.idCooperativaAssociacao, ca.Nome, ca.Fone_Whats, ca.Email, ca.Contato, ca.Fone_Contato, ca.Endereco, ca.Ativo,
      (SELECT COUNT(*) FROM Produtor p WHERE p.CooperativaAssociacao_idCooperativaAssociacao = ca.idCooperativaAssociacao) +
      (SELECT COUNT(*) FROM UsuarioCooperativaAssociacao uc WHERE uc.CooperativaAssociacao_idCooperativaAssociacao = ca.idCooperativaAssociacao) AS TotalVinculos
    FROM CooperativaAssociacao ca
    ORDER BY ca.Nome COLLATE NOCASE
  `).all());
  return res.status(status).render('associations', { pageTitle: 'Associações', associations, error });
}

function validateAssociationFields(body) {
  const fields = {
    name: String(body.name || '').trim(),
    whatsapp: String(body.whatsapp || '').trim(),
    email: String(body.email || '').trim(),
    contact: String(body.contact || '').trim(),
    contactPhone: String(body.contactPhone || '').trim(),
    address: String(body.address || '').trim()
  };
  if (fields.name.length < 2 || fields.name.length > 150) return { error: 'Informe um nome de associação válido.' };
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return { error: 'Informe um e-mail válido.' };
  if (Object.values(fields).some((value) => value.length > 250)) return { error: 'Um dos campos excede o limite permitido.' };
  return fields;
}

app.get('/admin/associacoes', requireAuth, requireAdministrator, async (req, res) => (await renderAssociations(res)));

app.post('/admin/associacoes', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const fields = validateAssociationFields(req.body);
  if (fields.error) return (await renderAssociations(res, fields.error, 400));
  try {
    (await db.prepare('INSERT INTO CooperativaAssociacao (Nome, Fone_Whats, Email, Contato, Fone_Contato, Endereco) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fields.name, fields.whatsapp || null, fields.email || null, fields.contact || null, fields.contactPhone || null, fields.address || null));
    return res.redirect('/admin/associacoes');
  } catch {
    return (await renderAssociations(res, 'Não foi possível criar a associação.', 400));
  }
});

app.post('/admin/associacoes/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const associationId = Number(req.params.id);
  const fields = validateAssociationFields(req.body);
  const active = String(req.body.active || '');
  if (fields.error) return (await renderAssociations(res, fields.error, 400));
  if (!['0', '1'].includes(active)) return (await renderAssociations(res, 'Selecione uma situação válida.', 400));
  try {
    (await db.prepare(`
      UPDATE CooperativaAssociacao
      SET Nome = ?, Fone_Whats = ?, Email = ?, Contato = ?, Fone_Contato = ?, Endereco = ?, Ativo = ?
      WHERE idCooperativaAssociacao = ?
    `).run(fields.name, fields.whatsapp || null, fields.email || null, fields.contact || null, fields.contactPhone || null, fields.address || null, Number(active), associationId));
    return res.redirect('/admin/associacoes');
  } catch {
    return (await renderAssociations(res, 'Não foi possível atualizar a associação.', 400));
  }
});

app.post('/admin/associacoes/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const associationId = Number(req.params.id);
  try {
    (await db.prepare('DELETE FROM CooperativaAssociacao WHERE idCooperativaAssociacao = ?').run(associationId));
    return res.redirect('/admin/associacoes');
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'A associação possui produtores ou gestores vinculados. Inative-a para preservar o histórico.'
      : 'Não foi possível excluir a associação.';
    return (await renderAssociations(res, message, 400));
  }
});

async function renderLocalities(res, error = null, status = 200) {
  const states = (await db.prepare(`
    SELECT e.idEstado, e.Sigla, e.Nome, e.Ativo,
      (SELECT COUNT(*) FROM Municipio m WHERE m.Estado_idEstado = e.idEstado) AS TotalMunicipios
    FROM Estado e ORDER BY e.Nome COLLATE NOCASE
  `).all());
  const municipalities = (await db.prepare(`
    SELECT m.idMunicipio, m.Estado_idEstado, m.Nome, m.Ativo, e.Nome AS EstadoNome, e.Sigla AS EstadoSigla, e.Ativo AS EstadoAtivo
    FROM Municipio m JOIN Estado e ON e.idEstado = m.Estado_idEstado
    ORDER BY e.Nome COLLATE NOCASE, m.Nome COLLATE NOCASE
  `).all());
  return res.status(status).render('localities', { pageTitle: 'Estados e Municípios', states, municipalities, error });
}

function validateStateFields(body) {
  const sigla = String(body.sigla || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  if (!/^[A-Z]{2,5}$/.test(sigla)) return { error: 'Informe uma sigla válida.' };
  if (name.length < 2 || name.length > 100) return { error: 'Informe um nome de Estado válido.' };
  return { sigla, name };
}

async function validateMunicipalityFields(body, allowInactiveStateId = null) {
  const name = String(body.name || '').trim();
  const stateId = body.stateId ? Number(body.stateId) : null;
  if (name.length < 2 || name.length > 120) return { error: 'Informe um nome de Município válido.' };
  const state = Number.isInteger(stateId)
    ? (await db.prepare('SELECT Ativo FROM Estado WHERE idEstado = ?').get(stateId))
    : null;
  if (!state || (state.Ativo !== 1 && stateId !== allowInactiveStateId)) {
    return { error: 'Selecione um Estado ativo.' };
  }
  return { name, stateId };
}

app.get('/admin/localidades', requireAuth, requireAdministrator, async (req, res) => (await renderLocalities(res)));

app.post('/admin/estados', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const fields = validateStateFields(req.body);
  if (fields.error) return (await renderLocalities(res, fields.error, 400));
  try {
    (await db.prepare('INSERT INTO Estado (Sigla, Nome) VALUES (?, ?)').run(fields.sigla, fields.name));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Já existe um Estado com essa sigla ou nome.' : 'Não foi possível criar o Estado.';
    return (await renderLocalities(res, message, 400));
  }
});

app.post('/admin/estados/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const stateId = Number(req.params.id);
  const fields = validateStateFields(req.body);
  const active = String(req.body.active || '');
  if (fields.error) return (await renderLocalities(res, fields.error, 400));
  if (!['0', '1'].includes(active)) return (await renderLocalities(res, 'Selecione uma situação válida.', 400));
  try {
    const result = (await db.prepare('UPDATE Estado SET Sigla = ?, Nome = ?, Ativo = ? WHERE idEstado = ?')
      .run(fields.sigla, fields.name, Number(active), stateId));
    if (!result.changes) return (await renderLocalities(res, 'Estado não encontrado.', 404));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Já existe um Estado com essa sigla ou nome.' : 'Não foi possível atualizar o Estado.';
    return (await renderLocalities(res, message, 400));
  }
});

app.post('/admin/estados/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  try {
    (await db.prepare('DELETE FROM Estado WHERE idEstado = ?').run(Number(req.params.id)));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'Este Estado possui Municípios vinculados. Inative-o para preservar o histórico.'
      : 'Não foi possível excluir o Estado.';
    return (await renderLocalities(res, message, 400));
  }
});

app.post('/admin/municipios', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const fields = (await validateMunicipalityFields(req.body));
  if (fields.error) return (await renderLocalities(res, fields.error, 400));
  try {
    (await db.prepare('INSERT INTO Municipio (Estado_idEstado, Nome) VALUES (?, ?)').run(fields.stateId, fields.name));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este Município já existe para o Estado selecionado.' : 'Não foi possível criar o Município.';
    return (await renderLocalities(res, message, 400));
  }
});

app.post('/admin/municipios/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const municipalityId = Number(req.params.id);
  const current = (await db.prepare('SELECT Estado_idEstado FROM Municipio WHERE idMunicipio = ?').get(municipalityId));
  if (!current) return (await renderLocalities(res, 'Município não encontrado.', 404));
  const fields = (await validateMunicipalityFields(req.body, current.Estado_idEstado));
  const active = String(req.body.active || '');
  if (fields.error) return (await renderLocalities(res, fields.error, 400));
  if (!['0', '1'].includes(active)) return (await renderLocalities(res, 'Selecione uma situação válida.', 400));
  try {
    (await db.prepare('UPDATE Municipio SET Estado_idEstado = ?, Nome = ?, Ativo = ? WHERE idMunicipio = ?')
      .run(fields.stateId, fields.name, Number(active), municipalityId));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este Município já existe para o Estado selecionado.' : 'Não foi possível atualizar o Município.';
    return (await renderLocalities(res, message, 400));
  }
});

app.post('/admin/municipios/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  try {
    (await db.prepare('DELETE FROM Municipio WHERE idMunicipio = ?').run(Number(req.params.id)));
    return res.redirect('/admin/localidades');
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'Este Município possui propriedades vinculadas. Inative-o para preservar o histórico.'
      : 'Não foi possível excluir o Município.';
    return (await renderLocalities(res, message, 400));
  }
});

const unitTypes = {
  producao: { table: 'Unidade', id: 'idUnidade', label: 'unidade de produção' },
  area: { table: 'UnidadeArea', id: 'idUnidadeArea', label: 'unidade de área' }
};

async function renderUnits(res, error = null, status = 200) {
  const productionUnits = (await db.prepare('SELECT idUnidade, Nome, Sigla, Ativo FROM Unidade ORDER BY Nome COLLATE NOCASE').all());
  const areaUnits = (await db.prepare('SELECT idUnidadeArea, Nome, Sigla, Ativo FROM UnidadeArea ORDER BY Nome COLLATE NOCASE').all());
  return res.status(status).render('units', { pageTitle: 'Unidades', productionUnits, areaUnits, error });
}

function validateUnitFields(body) {
  const name = String(body.name || '').trim();
  const sigla = String(body.sigla || '').trim();
  if (name.length < 1 || name.length > 100) return { error: 'Informe um nome de unidade válido.' };
  if (sigla.length < 1 || sigla.length > 12) return { error: 'Informe uma sigla de até 12 caracteres.' };
  return { name, sigla };
}

app.get('/admin/unidades', requireAuth, requireAdministrator, async (req, res) => (await renderUnits(res)));

app.post('/admin/unidades/:type', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const config = unitTypes[req.params.type];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'O tipo de unidade não existe.' });
  const fields = validateUnitFields(req.body);
  if (fields.error) return (await renderUnits(res, fields.error, 400));
  try {
    (await db.prepare(`INSERT INTO ${config.table} (Nome, Sigla) VALUES (?, ?)`).run(fields.name, fields.sigla));
    return res.redirect('/admin/unidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Já existe uma unidade com esse nome ou sigla.' : 'Não foi possível criar a unidade.';
    return (await renderUnits(res, message, 400));
  }
});

app.post('/admin/unidades/:type/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const config = unitTypes[req.params.type];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'O tipo de unidade não existe.' });
  const unitId = Number(req.params.id);
  const fields = validateUnitFields(req.body);
  const active = String(req.body.active || '');
  if (fields.error) return (await renderUnits(res, fields.error, 400));
  if (!['0', '1'].includes(active)) return (await renderUnits(res, 'Selecione uma situação válida.', 400));
  try {
    const result = (await db.prepare(`UPDATE ${config.table} SET Nome = ?, Sigla = ?, Ativo = ? WHERE ${config.id} = ?`)
      .run(fields.name, fields.sigla, Number(active), unitId));
    if (!result.changes) return (await renderUnits(res, 'Unidade não encontrada.', 404));
    return res.redirect('/admin/unidades');
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Já existe uma unidade com esse nome ou sigla.' : 'Não foi possível atualizar a unidade.';
    return (await renderUnits(res, message, 400));
  }
});

app.post('/admin/unidades/:type/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const config = unitTypes[req.params.type];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'O tipo de unidade não existe.' });
  try {
    (await db.prepare(`DELETE FROM ${config.table} WHERE ${config.id} = ?`).run(Number(req.params.id)));
    return res.redirect('/admin/unidades');
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? `Esta ${config.label} está vinculada a registros. Inative-a para preservar o histórico.`
      : 'Não foi possível excluir a unidade.';
    return (await renderUnits(res, message, 400));
  }
});

const animalParameterTypes = {
  categorias: {
    table: 'Categoria', id: 'idCategoria', title: 'Categorias', singular: 'categoria', orderBy: 'IdadeMinima, Sexo',
    fields: [
      { column: 'Nome', name: 'name', label: 'Nome da categoria', type: 'text', maxLength: 100 },
      { column: 'Sexo', name: 'sex', label: 'Sexo do animal', type: 'select', options: [{ value: 'M', label: 'Macho' }, { value: 'F', label: 'Fêmea' }] },
      { column: 'IdadeMinima', name: 'minimumAge', label: 'Idade mínima', type: 'number', min: 0, step: '0.1' },
      { column: 'IdadeMaxima', name: 'maximumAge', label: 'Idade máxima', type: 'number', min: 0, step: '0.1' }
    ]
  },
  'motivos-saida': {
    table: 'MotivoSaida', id: 'idMotivoSaida', title: 'Motivos de Saída', singular: 'motivo de saída', orderBy: 'Descricao',
    fields: [{ column: 'Descricao', name: 'description', label: 'Descrição', type: 'text', maxLength: 120 }]
  },
  'tipos-prenhez': {
    table: 'TipoPrenhez', id: 'idTipoPrenhez', title: 'Tipos de Prenhez', singular: 'tipo de prenhez', orderBy: 'Nome',
    fields: [{ column: 'Nome', name: 'name', label: 'Nome', type: 'text', maxLength: 100 }]
  },
  'tipos-parto': {
    table: 'TipoParto', id: 'idTipoParto', title: 'Tipos de Parto', singular: 'tipo de parto', orderBy: 'Nome',
    fields: [
      { column: 'Nome', name: 'name', label: 'Nome', type: 'text', maxLength: 100 },
      { column: 'Quantidade', name: 'quantity', label: 'Quantidade de animais nascidos', type: 'number', min: 1, max: 20, step: '1' }
    ]
  }
};

async function renderAnimalParameters(res, slug, error = null, status = 200) {
  const config = animalParameterTypes[slug];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'Este parâmetro pecuário não existe.' });
  const columns = config.fields.map((field) => field.column).join(', ');
  const records = (await db.prepare(`SELECT ${config.id} AS id, ${columns}, Ativo FROM ${config.table} ORDER BY ${config.orderBy}`).all());
  const pendingCategories = slug === 'categorias'
    ? (await db.prepare("SELECT COUNT(*) AS total FROM Categoria WHERE Sexo IS NULL OR Nome LIKE 'Pendente de classificação %'").get()).total
    : 0;
  const catalog = { slug, ...config, records };
  return res.status(status).render('animal-parameters', { pageTitle: config.title, catalogs: [catalog], pendingCategories, error });
}

function validateAnimalParameter(slug, body) {
  const config = animalParameterTypes[slug];
  if (!config) return { error: 'Parâmetro não encontrado.' };
  const values = [];
  const normalized = {};
  for (const field of config.fields) {
    const raw = String(body[field.name] ?? '').trim();
    if (!raw) return { error: `Preencha o campo ${field.label}.` };
    let value;
    if (field.type === 'select') {
      if (!field.options.some((option) => option.value === raw)) return { error: `Selecione uma opção válida para ${field.label.toLowerCase()}.` };
      value = raw;
    } else if (field.type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value) || value < field.min) return { error: `${field.label} deve ser um número igual ou maior que zero.` };
      if (field.max !== undefined && value > field.max) return { error: `${field.label} não pode exceder ${field.max}.` };
      if (field.step === '1' && !Number.isInteger(value)) return { error: `${field.label} deve ser um número inteiro.` };
    } else {
      if (raw.length > field.maxLength) return { error: `${field.label} excede ${field.maxLength} caracteres.` };
      value = raw;
    }
    values.push(value);
    normalized[field.column] = value;
  }
  if (slug === 'categorias' && normalized.IdadeMaxima < normalized.IdadeMinima) {
    return { error: 'A idade máxima deve ser maior ou igual à idade mínima.' };
  }
  return { config, values };
}

app.get('/admin/parametros-pecuarios', requireAuth, requireAdministrator, (req, res) => res.redirect('/admin/parametros-pecuarios/categorias'));
app.get('/admin/parametros-pecuarios/:catalog', requireAuth, requireAdministrator, async (req, res) => (await renderAnimalParameters(res, req.params.catalog)));

app.post('/admin/parametros-pecuarios/:catalog', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const validated = validateAnimalParameter(req.params.catalog, req.body);
  if (validated.error) return (await renderAnimalParameters(res, req.params.catalog, validated.error, 400));
  const columns = validated.config.fields.map((field) => field.column).join(', ');
  const placeholders = validated.values.map(() => '?').join(', ');
  try {
    (await db.prepare(`INSERT INTO ${validated.config.table} (${columns}) VALUES (${placeholders})`).run(...validated.values));
    return res.redirect(`/admin/parametros-pecuarios/${req.params.catalog}`);
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'Este registro já existe.'
      : 'Não foi possível criar o registro.';
    return (await renderAnimalParameters(res, req.params.catalog, message, 400));
  }
});

app.post('/admin/parametros-pecuarios/:catalog/:id/atualizar', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const config = animalParameterTypes[req.params.catalog];
  const validated = validateAnimalParameter(req.params.catalog, req.body);
  const active = String(req.body.active || '');
  if (!config) return (await renderAnimalParameters(res, req.params.catalog, 'Parâmetro não encontrado.', 404));
  if (validated.error) return (await renderAnimalParameters(res, req.params.catalog, validated.error, 400));
  if (!['0', '1'].includes(active)) return (await renderAnimalParameters(res, req.params.catalog, 'Selecione uma situação válida.', 400));
  const setFields = config.fields.map((field) => `${field.column} = ?`).join(', ');
  try {
    const result = (await db.prepare(`UPDATE ${config.table} SET ${setFields}, Ativo = ? WHERE ${config.id} = ?`)
      .run(...validated.values, Number(active), Number(req.params.id)));
    if (!result.changes) return (await renderAnimalParameters(res, req.params.catalog, 'Registro não encontrado.', 404));
    return res.redirect(`/admin/parametros-pecuarios/${req.params.catalog}`);
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este registro já existe.' : 'Não foi possível atualizar o registro.';
    return (await renderAnimalParameters(res, req.params.catalog, message, 400));
  }
});

app.post('/admin/parametros-pecuarios/:catalog/:id/excluir', requireAuth, requireAdministrator, verifyCsrf, async (req, res) => {
  const config = animalParameterTypes[req.params.catalog];
  if (!config) return (await renderAnimalParameters(res, req.params.catalog, 'Parâmetro não encontrado.', 404));
  try {
    (await db.prepare(`DELETE FROM ${config.table} WHERE ${config.id} = ?`).run(Number(req.params.id)));
    return res.redirect(`/admin/parametros-pecuarios/${req.params.catalog}`);
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? `O parâmetro ${config.singular} está vinculado a registros. Inative-o para preservar o histórico.`
      : 'Não foi possível excluir o registro.';
    return (await renderAnimalParameters(res, req.params.catalog, message, 400));
  }
});

const managerCatalogTypes = {
  atividades: {
    table: 'Atividade', id: 'idAtividade', title: 'Atividades', description: 'Atividades de agricultura e pecuária', orderBy: 'Descricao',
    fields: [
      { column: 'Descricao', name: 'description', label: 'Descrição', type: 'text', maxLength: 120 },
      { column: 'Agricultura', name: 'agriculture', label: 'Agricultura', type: 'checkbox' },
      { column: 'Pecuaria', name: 'livestock', label: 'Pecuária', type: 'checkbox' }
    ]
  },
  safras: {
    table: 'SafraPeriodo', id: 'idSafraPeriodo', title: 'Safras e períodos', description: 'Períodos de produção', orderBy: 'Inicio DESC',
    fields: [
      { column: 'Descricao', name: 'description', label: 'Descrição', type: 'text', maxLength: 120 },
      { column: 'Inicio', name: 'startDate', label: 'Início', type: 'date' },
      { column: 'Termino', name: 'endDate', label: 'Término', type: 'date' }
    ]
  },
  produtos: {
    table: 'Produto', id: 'idProduto', title: 'Produtos', description: 'Produtos vinculados à atividade e unidade', orderBy: 'Nome',
    fields: [
      { column: 'Atividade_idAtividade', name: 'activityId', label: 'Atividade', type: 'select', optionSql: 'SELECT idAtividade AS id, Descricao AS label, Ativo FROM Atividade ORDER BY Descricao COLLATE NOCASE', optionLookupSql: 'SELECT Ativo FROM Atividade WHERE idAtividade = ?' },
      { column: 'Unidade_idUnidade', name: 'unitId', label: 'Unidade', type: 'select', optionSql: "SELECT idUnidade AS id, Nome || ' (' || Sigla || ')' AS label, Ativo FROM Unidade ORDER BY Nome COLLATE NOCASE", optionLookupSql: 'SELECT Ativo FROM Unidade WHERE idUnidade = ?' },
      { column: 'Nome', name: 'name', label: 'Nome', type: 'text', maxLength: 120 },
      { column: 'Descricao', name: 'description', label: 'Descrição', type: 'textarea', required: false, maxLength: 500 },
      { column: 'DiasProducao', name: 'productionDays', label: 'Dias de produção', type: 'number', required: false, min: 0, integer: true }
    ]
  },
  manejos: {
    table: 'Manejo', id: 'idManejo', title: 'Manejos', description: 'Práticas e intervalos de segurança', orderBy: 'Descricao',
    fields: [
      { column: 'Descricao', name: 'description', label: 'Descrição', type: 'text', maxLength: 150 },
      { column: 'IntervaloSeguridade', name: 'safetyInterval', label: 'Intervalo de segurança (dias)', type: 'number', required: false, min: 0, integer: true },
      { column: 'BoasPraticas', name: 'goodPractices', label: 'Boas práticas', type: 'textarea', required: false, maxLength: 1000 }
    ]
  },
  compradores: {
    table: 'Comprador', id: 'idComprador', title: 'Compradores', description: 'Pessoas e organizações compradoras', orderBy: 'NomeComprador',
    fields: [
      { column: 'NomeComprador', name: 'name', label: 'Nome do comprador', type: 'text', maxLength: 150 },
      { column: 'Fone', name: 'phone', label: 'Telefone', type: 'tel', required: false, maxLength: 40 },
      { column: 'EmailComprador', name: 'email', label: 'E-mail', type: 'email', required: false, maxLength: 150 },
      { column: 'Contato', name: 'contact', label: 'Contato', type: 'text', required: false, maxLength: 120 }
    ]
  },
  'manejo-produto': {
    table: 'ManejoProduto', id: 'idManejoProduto', title: 'Manejo por produto', description: 'Relação entre manejo e produto', orderBy: 'Manejo_idManejo',
    fields: [
      { column: 'Manejo_idManejo', name: 'managementId', label: 'Manejo', type: 'select', optionSql: 'SELECT idManejo AS id, Descricao AS label, Ativo FROM Manejo ORDER BY Descricao COLLATE NOCASE', optionLookupSql: 'SELECT Ativo FROM Manejo WHERE idManejo = ?' },
      { column: 'Produto_idProduto', name: 'productId', label: 'Produto', type: 'select', optionSql: 'SELECT idProduto AS id, Nome AS label, Ativo FROM Produto ORDER BY Nome COLLATE NOCASE', optionLookupSql: 'SELECT Ativo FROM Produto WHERE idProduto = ?' },
      { column: 'Intervalo', name: 'interval', label: 'Intervalo (dias)', type: 'number', required: false, min: 0, integer: true }
    ]
  }
};

function requireCatalogManager(req, res, next) {
  if (!['Administrador', 'Gestor'].includes(req.user.Perfil)) {
    return res.status(403).render('error', { pageTitle: 'Acesso restrito', message: 'Seu perfil não pode alterar estes cadastros.' });
  }
  next();
}

async function renderManagerCatalogs(res) {
  const catalogs = [];
  for (const [slug, config] of Object.entries(managerCatalogTypes)) {
    catalogs.push({
      slug,
      title: config.title,
      description: config.description,
      total: (await db.prepare(`SELECT COUNT(*) AS total FROM ${config.table}`).get()).total
    });
  }
  return res.render('manager-catalogs', { pageTitle: 'Configurações de produção', catalogs });
}

async function renderManagerCatalog(res, slug, error = null, status = 200) {
  const config = managerCatalogTypes[slug];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'Este cadastro não existe.' });
  const columns = config.fields.map((field) => field.column).join(', ');
  const records = (await db.prepare(`SELECT ${config.id} AS id, ${columns}, Ativo FROM ${config.table} ORDER BY ${config.orderBy}`).all());
  const options = {};
  for (const field of config.fields) {
    if (field.type === 'select') options[field.name] = (await db.prepare(field.optionSql).all());
  }
  return res.status(status).render('manager-catalog', { pageTitle: config.title, catalog: { slug, ...config }, records, options, error });
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function validateManagerCatalog(slug, body, current = null) {
  const config = managerCatalogTypes[slug];
  if (!config) return { error: 'Este cadastro não existe.' };
  const values = [];
  const normalized = {};
  for (const field of config.fields) {
    const raw = String(body[field.name] ?? '').trim();
    let value;
    if (field.type === 'checkbox') {
      value = body[field.name] === '1' ? 1 : 0;
    } else if (field.type === 'select') {
      const id = Number(raw);
      const option = Number.isInteger(id) ? (await db.prepare(field.optionLookupSql).get(id)) : null;
      if (!option || (option.Ativo !== 1 && Number(current?.[field.column]) !== id)) {
        return { error: `Selecione uma opção ativa para ${field.label.toLowerCase()}.` };
      }
      value = id;
    } else if (!raw && field.required === false) {
      value = null;
    } else if (!raw) {
      return { error: `Preencha o campo ${field.label}.` };
    } else if (field.type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value) || value < field.min || (field.integer && !Number.isInteger(value))) {
        return { error: `${field.label} deve ser um número válido${field.integer ? ' inteiro' : ''}.` };
      }
    } else if (field.type === 'date') {
      if (!isValidIsoDate(raw)) return { error: `Informe uma data válida para ${field.label.toLowerCase()}.` };
      value = raw;
    } else {
      if (raw.length > field.maxLength) return { error: `${field.label} excede ${field.maxLength} caracteres.` };
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { error: 'Informe um e-mail válido.' };
      value = raw;
    }
    values.push(value);
    normalized[field.column] = value;
  }

  if (slug === 'atividades' && !normalized.Agricultura && !normalized.Pecuaria) {
    return { error: 'Marque Agricultura, Pecuária ou ambas.' };
  }
  if (slug === 'safras' && normalized.Termino < normalized.Inicio) {
    return { error: 'O término deve ser igual ou posterior ao início.' };
  }
  return { config, values };
}

app.get('/admin/configuracoes', requireAuth, requireCatalogManager, async (req, res) => (await renderManagerCatalogs(res)));
app.get('/admin/configuracoes/:catalog', requireAuth, requireCatalogManager, async (req, res) => (await renderManagerCatalog(res, req.params.catalog)));

app.post('/admin/configuracoes/:catalog', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const validated = (await validateManagerCatalog(req.params.catalog, req.body));
  if (validated.error) return (await renderManagerCatalog(res, req.params.catalog, validated.error, 400));
  const columns = validated.config.fields.map((field) => field.column).join(', ');
  const placeholders = validated.values.map(() => '?').join(', ');
  try {
    (await db.prepare(`INSERT INTO ${validated.config.table} (${columns}) VALUES (${placeholders})`).run(...validated.values));
    return res.redirect(`/admin/configuracoes/${req.params.catalog}`);
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este registro ou vínculo já existe.' : 'Não foi possível criar o registro.';
    return (await renderManagerCatalog(res, req.params.catalog, message, 400));
  }
});

app.post('/admin/configuracoes/:catalog/:id/atualizar', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const config = managerCatalogTypes[req.params.catalog];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'Este cadastro não existe.' });
  const current = (await db.prepare(`SELECT ${config.fields.map((field) => field.column).join(', ')} FROM ${config.table} WHERE ${config.id} = ?`).get(Number(req.params.id)));
  if (!current) return (await renderManagerCatalog(res, req.params.catalog, 'Registro não encontrado.', 404));
  const validated = (await validateManagerCatalog(req.params.catalog, req.body, current));
  const active = String(req.body.active || '');
  if (validated.error) return (await renderManagerCatalog(res, req.params.catalog, validated.error, 400));
  if (!['0', '1'].includes(active)) return (await renderManagerCatalog(res, req.params.catalog, 'Selecione uma situação válida.', 400));
  const assignments = config.fields.map((field) => `${field.column} = ?`).join(', ');
  try {
    (await db.prepare(`UPDATE ${config.table} SET ${assignments}, Ativo = ? WHERE ${config.id} = ?`)
      .run(...validated.values, Number(active), Number(req.params.id)));
    return res.redirect(`/admin/configuracoes/${req.params.catalog}`);
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Este registro ou vínculo já existe.' : 'Não foi possível atualizar o registro.';
    return (await renderManagerCatalog(res, req.params.catalog, message, 400));
  }
});

app.post('/admin/configuracoes/:catalog/:id/excluir', requireAuth, requireCatalogManager, verifyCsrf, async (req, res) => {
  const config = managerCatalogTypes[req.params.catalog];
  if (!config) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'Este cadastro não existe.' });
  try {
    (await db.prepare(`DELETE FROM ${config.table} WHERE ${config.id} = ?`).run(Number(req.params.id)));
    return res.redirect(`/admin/configuracoes/${req.params.catalog}`);
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'Este registro está vinculado a outros dados. Inative-o para preservar o histórico.'
      : 'Não foi possível excluir o registro.';
    return (await renderManagerCatalog(res, req.params.catalog, message, 400));
  }
});

async function propertyAssociations(user) {
  if (user.Perfil === 'Administrador') {
    return (await db.prepare('SELECT idCooperativaAssociacao, Nome, Ativo FROM CooperativaAssociacao ORDER BY Nome COLLATE NOCASE').all());
  }
  if (user.Perfil === 'Gestor') {
    return (await db.prepare(`
      SELECT ca.idCooperativaAssociacao, ca.Nome, ca.Ativo
      FROM UsuarioCooperativaAssociacao uc JOIN CooperativaAssociacao ca
        ON ca.idCooperativaAssociacao = uc.CooperativaAssociacao_idCooperativaAssociacao
      WHERE uc.Usuario_idUsuario = ? AND ca.Ativo = 1 ORDER BY ca.Nome COLLATE NOCASE
    `).all(user.idUsuario));
  }
  return (await db.prepare(`
    SELECT ca.idCooperativaAssociacao, ca.Nome, ca.Ativo
    FROM Produtor p JOIN CooperativaAssociacao ca
      ON ca.idCooperativaAssociacao = p.CooperativaAssociacao_idCooperativaAssociacao
    WHERE p.Usuario_idUsuario = ?
  `).all(user.idUsuario));
}

async function propertyProducerOptions(user, currentProducerId = null) {
  if (user.Perfil === 'Produtor') {
    return (await db.prepare(`
      SELECT p.idProdutor, p.Nome, p.CooperativaAssociacao_idCooperativaAssociacao, ca.Nome AS Associacao, p.Ativo
      FROM Produtor p JOIN CooperativaAssociacao ca
        ON ca.idCooperativaAssociacao = p.CooperativaAssociacao_idCooperativaAssociacao
      WHERE p.Usuario_idUsuario = ? AND (p.Ativo = 1 OR p.idProdutor = ?)
    `).all(user.idUsuario, currentProducerId || -1));
  }

  const associations = (await propertyAssociations(user));
  const associationIds = associations.map((association) => association.idCooperativaAssociacao);
  if (user.Perfil === 'Gestor' && !associationIds.length) return [];
  const conditions = ['u.Situacao = \'Ativo\'', '(p.Ativo = 1 OR p.idProdutor = ?)'];
  const params = [currentProducerId || -1];
  if (user.Perfil === 'Gestor') {
    conditions.push(`ca.idCooperativaAssociacao IN (${associationIds.map(() => '?').join(', ')})`);
    params.push(...associationIds);
  } else {
    conditions.push('ca.Ativo = 1');
  }
  return (await db.prepare(`
    SELECT p.idProdutor, p.Nome, p.CooperativaAssociacao_idCooperativaAssociacao, ca.Nome AS Associacao, p.Ativo
    FROM Produtor p JOIN Usuario u ON u.idUsuario = p.Usuario_idUsuario
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = p.CooperativaAssociacao_idCooperativaAssociacao
    WHERE ${conditions.join(' AND ')} ORDER BY ca.Nome COLLATE NOCASE, p.Nome COLLATE NOCASE
  `).all(...params));
}

async function propertyIsAccessible(user, property) {
  if (user.Perfil === 'Administrador') return true;
  if (user.Perfil === 'Produtor') {
    return Boolean((await db.prepare('SELECT 1 FROM Produtor WHERE idProdutor = ? AND Usuario_idUsuario = ?')
      .get(property.Produtor_idProdutor, user.idUsuario)));
  }
  return (await propertyAssociations(user)).some((association) =>
    association.idCooperativaAssociacao === property.CooperativaAssociacao_idCooperativaAssociacao
  );
}

async function accessibleLivestockActivities(user, currentActivityId = -1) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT ap.idAtividadePropriedade, ap.Propriedade_idPropriedade,
      COALESCE(NULLIF(trim(ap.Descricao), ''), a.Descricao || ' · ' || sp.Descricao) AS ActivityDescription,
      ap.Ativo AS AtividadePropriedadeAtiva, a.Ativo AS AtividadeAtiva, sp.Ativo AS SafraAtiva,
      prop.Nome AS PropriedadeNome, prop.Ativo AS PropriedadeAtiva,
      pr.Nome AS ProdutorNome, ca.Nome AS AssociacaoNome
    FROM AtividadePropriedade ap
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    WHERE ${scope.sql} AND a.Pecuaria = 1
      AND (ap.idAtividadePropriedade = ? OR (ap.Ativo = 1 AND a.Ativo = 1 AND sp.Ativo = 1 AND prop.Ativo = 1 AND pr.Ativo = 1 AND ca.Ativo = 1))
    ORDER BY prop.Nome COLLATE NOCASE, a.Descricao COLLATE NOCASE, sp.Inicio DESC
  `).all(...scope.params, currentActivityId));
}

async function animalFormOptions(user, animal = null) {
  const activities = (await accessibleLivestockActivities(user, animal?.AtividadePropriedade_idAtividadePropriedade || -1));
  const properties = [...new Map(activities.map((activity) => [activity.Propriedade_idPropriedade, {
    idPropriedade: activity.Propriedade_idPropriedade,
    Nome: activity.PropriedadeNome,
    ProdutorNome: activity.ProdutorNome
  }])).values()];
  const categories = (await db.prepare(`
    SELECT idCategoria, Nome, Sexo, Ativo FROM Categoria
    WHERE Sexo IN ('F', 'M') AND (Ativo = 1 OR idCategoria = ?)
    ORDER BY Sexo, IdadeMinima, Nome COLLATE NOCASE
  `).all(animal?.Categoria_idCategoria || -1));
  const exitReasons = (await db.prepare(`
    SELECT idMotivoSaida, Descricao, Ativo FROM MotivoSaida
    WHERE Ativo = 1 OR idMotivoSaida = ? ORDER BY Descricao COLLATE NOCASE
  `).all(animal?.MotivoSaida_idMotivoSaida || -1));
  return { activities, properties, categories, exitReasons };
}

function animalAgeInDays(birthDate, referenceDate = new Date().toISOString().slice(0, 10)) {
  if (!isValidIsoDate(birthDate)) return null;
  const days = (Date.parse(`${referenceDate}T00:00:00.000Z`) - Date.parse(`${birthDate}T00:00:00.000Z`)) / 86400000;
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : null;
}

function formatAnimalAge(birthDate, referenceDate = new Date().toISOString().slice(0, 10)) {
  const ageDays = animalAgeInDays(birthDate, referenceDate);
  if (ageDays === null) return '—';
  const birth = new Date(`${birthDate}T00:00:00.000Z`);
  const today = new Date(`${referenceDate}T00:00:00.000Z`);
  let months = (today.getUTCFullYear() - birth.getUTCFullYear()) * 12 + today.getUTCMonth() - birth.getUTCMonth();
  if (today.getUTCDate() < birth.getUTCDate()) months -= 1;
  if (months < 1) return `${ageDays} ${ageDays === 1 ? 'dia' : 'dias'}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (!years) return `${months} ${months === 1 ? 'mês' : 'meses'}`;
  return `${years} ${years === 1 ? 'ano' : 'anos'}${remainingMonths ? ` e ${remainingMonths} ${remainingMonths === 1 ? 'mês' : 'meses'}` : ''}`;
}

function addMonthsToIsoDate(value, months) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(months)) return null;
  const wholeMonths = Math.trunc(months);
  const remainingDays = Math.round((months - wholeMonths) * 30.436875);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + wholeMonths);
  const lastDayOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDayOfMonth) + remainingDays);
  return date.toISOString().slice(0, 10);
}

async function renderAnimals(res, user, filters = {}, error = null, status = 200) {
  const { activities, properties } = (await animalFormOptions(user));
  const referenceDate = new Date().toISOString().slice(0, 10);
  let propertyId = Number(filters.propertyId) || null;
  if (propertyId && !properties.some((property) => property.idPropriedade === propertyId)) propertyId = null;
  const herd = ['0', '1'].includes(String(filters.herd)) ? String(filters.herd) : '';
  const scope = producerScope(user, 'pr');
  const conditions = [scope.sql, 'a.Pecuaria = 1'];
  const params = [...scope.params];
  if (propertyId) {
    conditions.push('prop.idPropriedade = ?');
    params.push(propertyId);
  }
  if (herd) {
    conditions.push('animal.PertenceRebanho = ?');
    params.push(Number(herd));
  }
  const animals = (await db.prepare(`
    SELECT animal.*, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome, ca.Nome AS AssociacaoNome,
      a.Descricao AS AtividadeNome, sp.Descricao AS SafraNome, cat.Nome AS CategoriaNome,
      ap.IdadeCobertura,
      ms.Descricao AS MotivoSaida
    FROM Animal animal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    LEFT JOIN Categoria cat ON cat.idCategoria = animal.Categoria_idCategoria
    LEFT JOIN MotivoSaida ms ON ms.idMotivoSaida = animal.MotivoSaida_idMotivoSaida
    WHERE ${conditions.join(' AND ')}
    ORDER BY animal.PertenceRebanho DESC, animal.Brinco COLLATE NOCASE
  `).all(...params)).map((animal) => {
    const coverageDate = animal.IdadeCobertura === null
      ? null
      : addMonthsToIsoDate(animal.Nascimento, Number(animal.IdadeCobertura));
    const daysToCoverage = coverageDate
      ? Math.floor((Date.parse(`${coverageDate}T00:00:00.000Z`) - Date.parse(`${referenceDate}T00:00:00.000Z`)) / 86400000)
      : null;
    return {
      ...animal,
      Idade: formatAnimalAge(animal.Nascimento, referenceDate),
      PodeRegistrarPrenhez: daysToCoverage === null
        ? ['novilha', 'vaca'].includes(String(animal.CategoriaNome || '').toLocaleLowerCase('pt-BR'))
        : daysToCoverage <= 0
    };
  });
  return res.status(status).render('animals', { pageTitle: 'Animais', animals, activities, properties, propertyId, herd, error });
}

async function loadAnimalForUser(animalId, user) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT animal.*, ap.Propriedade_idPropriedade, prop.Nome AS PropriedadeNome,
      a.Pecuaria, pr.Nome AS ProdutorNome, pr.CooperativaAssociacao_idCooperativaAssociacao
    FROM Animal animal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE animal.idAnimal = ? AND a.Pecuaria = 1 AND ${scope.sql}
  `).get(animalId, ...scope.params));
}

async function renderAnimalForm(res, user, animal = null, error = null, status = 200, formValues = {}) {
  const options = (await animalFormOptions(user, animal));
  const values = Object.keys(formValues).length
    ? { ...formValues, belongsToHerd: formValues.belongsToHerd === '1' ? '1' : '0' }
    : { belongsToHerd: animal ? String(animal.PertenceRebanho) : '1' };
  return res.status(status).render('animal-form', {
    pageTitle: animal ? `Animal ${animal.Brinco}` : 'Novo animal',
    animal, existing: Boolean(animal), error, formValues: values, ...options
  });
}

async function validateAnimalFields(body, user, current = null) {
  const propertyId = Number(body.propertyId);
  const activityId = Number(body.activityPropertyId);
  const activity = (await accessibleLivestockActivities(user, current?.AtividadePropriedade_idAtividadePropriedade || -1))
    .find((option) => option.idAtividadePropriedade === activityId && option.Propriedade_idPropriedade === propertyId);
  const property = Number.isInteger(propertyId) ? (await loadProperty(propertyId)) : null;
  if (!activity || !property || !(await propertyIsAccessible(user, property))) {
    return { error: 'Selecione uma atividade pecuária de uma propriedade disponível para seu perfil.' };
  }

  const tag = String(body.tag || '').trim();
  if (!tag || tag.length > 80) return { error: 'Informe um brinco válido, com até 80 caracteres.' };
  const duplicate = (await db.prepare(`
    SELECT 1 FROM Animal other
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = other.AtividadePropriedade_idAtividadePropriedade
    WHERE ap.Propriedade_idPropriedade = ? AND other.Brinco = ? COLLATE NOCASE
      AND other.idAnimal <> ? LIMIT 1
  `).get(propertyId, tag, current?.idAnimal || -1));
  if (duplicate) return { error: 'Já existe um animal com este brinco na propriedade selecionada.' };

  const sex = String(body.sex || '');
  if (!['F', 'M'].includes(sex)) return { error: 'Selecione o sexo do animal.' };
  if (current && sex !== current.Sexo && (current.Prenhez_idPrenhez || (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND Termino IS NULL LIMIT 1').get(current.idAnimal)))) {
    return { error: 'Não é possível alterar o sexo de um animal com prenhez ou lactação vinculada.' };
  }
  const categoryId = Number(body.categoryId);
  const category = Number.isInteger(categoryId) ? (await db.prepare('SELECT Sexo, Ativo FROM Categoria WHERE idCategoria = ?').get(categoryId)) : null;
  if (!category || category.Sexo !== sex || (category.Ativo !== 1 && categoryId !== current?.Categoria_idCategoria)) {
    return { error: 'Selecione uma categoria ativa e compatível com o sexo do animal.' };
  }

  const birthDate = String(body.birthDate || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(birthDate) || birthDate > today) return { error: 'Informe uma data de nascimento válida, não futura.' };
  const firstCalving = String(body.firstCalving || '').trim() || null;
  if (firstCalving && (sex !== 'F' || !isValidIsoDate(firstCalving) || firstCalving < birthDate || firstCalving > today)) {
    return { error: 'A data do primeiro parto deve ser válida e pertencer a uma fêmea.' };
  }

  const belongsToHerd = body.belongsToHerd === '1' ? 1 : 0;
  const exitDate = belongsToHerd ? null : String(body.exitDate ?? current?.DataSaida ?? today).trim() || today;
  const exitReasonId = belongsToHerd || !body.exitReasonId ? null : Number(body.exitReasonId);
  const exitReason = belongsToHerd ? null : String(body.exitReason || '').trim() || null;
  if (exitDate && (!isValidIsoDate(exitDate) || exitDate < birthDate || exitDate > today)) {
    return { error: 'Informe uma data de saída válida, entre o nascimento e hoje.' };
  }
  if (exitReasonId !== null) {
    const reason = Number.isInteger(exitReasonId) ? (await db.prepare('SELECT Ativo FROM MotivoSaida WHERE idMotivoSaida = ?').get(exitReasonId)) : null;
    if (!reason || (reason.Ativo !== 1 && exitReasonId !== current?.MotivoSaida_idMotivoSaida)) {
      return { error: 'Selecione um motivo de saída ativo.' };
    }
  }
  if (exitReason && exitReason.length > 250) return { error: 'A observação da saída excede 250 caracteres.' };
  return {
    activityId, categoryId, tag, birthDate, firstCalving, sex, belongsToHerd,
    exitDate, exitReasonId, exitReason,
    reproductiveStatus: sex === 'M' ? 'Não aplicável' : current?.StatusReprodutivo || 'Vazia'
  };
}

function addDaysToIsoDate(value, days) {
  if (!isValidIsoDate(value) || !Number.isInteger(days)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadPregnancyForUser(pregnancyId, user) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT preg.*, mother.Brinco AS MotherTag, mother.Sexo AS MotherSex,
      mother.AtividadePropriedade_idAtividadePropriedade, mother.StatusReprodutivo AS MotherStatus,
      father.Brinco AS FatherTag, prop.idPropriedade, prop.Nome AS PropriedadeNome,
      prop.DiasGestacao,
      pr.Nome AS ProdutorNome
    FROM Prenhez preg
    JOIN Animal mother ON mother.idAnimal = preg.Animal_idAnimalMae
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = mother.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    LEFT JOIN Animal father ON father.idAnimal = preg.Animal_idAnimalPai
    WHERE preg.idPrenhez = ? AND a.Pecuaria = 1 AND ${scope.sql}
  `).get(pregnancyId, ...scope.params));
}

async function pregnancySires(user, propertyId) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT animal.idAnimal, animal.Brinco FROM Animal animal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE animal.Sexo = 'M' AND animal.PertenceRebanho = 1 AND ap.Ativo = 1 AND a.Pecuaria = 1
      AND prop.idPropriedade = ? AND ${scope.sql}
    ORDER BY animal.Brinco COLLATE NOCASE
  `).all(propertyId, ...scope.params));
}

async function renderPregnancies(res, user, view = 'available', error = null, status = 200) {
  const scope = producerScope(user, 'pr');
  const referenceDate = new Date().toISOString().slice(0, 10);
  let availableFemales = [];
  if (view === 'available') availableFemales = (await db.prepare(`
    SELECT animal.idAnimal, animal.Brinco, animal.Nascimento, animal.StatusReprodutivo,
      cat.Nome AS CategoriaNome, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome,
      ap.Propriedade_idPropriedade, ap.IdadeCobertura
    FROM Animal animal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    LEFT JOIN Categoria cat ON cat.idCategoria = animal.Categoria_idCategoria
    WHERE animal.Sexo = 'F' AND animal.PertenceRebanho = 1 AND animal.StatusReprodutivo = 'Vazia'
      AND animal.Prenhez_idPrenhez IS NULL AND ap.Ativo = 1 AND prop.Ativo = 1 AND a.Pecuaria = 1 AND ${scope.sql}
    ORDER BY prop.Nome COLLATE NOCASE, animal.Brinco COLLATE NOCASE
  `).all(...scope.params)).map((animal) => {
    const coverageDate = animal.IdadeCobertura === null
      ? null
      : addMonthsToIsoDate(animal.Nascimento, Number(animal.IdadeCobertura));
    const daysToCoverage = coverageDate
      ? Math.floor((Date.parse(`${coverageDate}T00:00:00.000Z`) - Date.parse(`${referenceDate}T00:00:00.000Z`)) / 86400000)
      : null;
    return {
      ...animal,
      Idade: formatAnimalAge(animal.Nascimento, referenceDate),
      DiasParaCobertura: daysToCoverage,
      PodeRegistrarPrenhez: daysToCoverage === null
        ? ['novilha', 'vaca'].includes(String(animal.CategoriaNome || '').toLocaleLowerCase('pt-BR'))
        : daysToCoverage <= 0
    };
  });
  const heifersNearCoverage = availableFemales.filter((animal) =>
    String(animal.CategoriaNome || '').toLocaleLowerCase('pt-BR') === 'novilha'
      && animal.DiasParaCobertura >= 0 && animal.DiasParaCobertura <= 30
  );
  let pregnancies = [];
  if (view === 'records') pregnancies = (await db.prepare(`
    SELECT preg.*, mother.Brinco AS MotherTag, mother.StatusReprodutivo AS MotherStatus,
      father.Brinco AS FatherTag, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome,
      method.Nome AS MethodName, birthType.Nome AS BirthTypeName
    FROM Prenhez preg
    JOIN Animal mother ON mother.idAnimal = preg.Animal_idAnimalMae
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = mother.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    LEFT JOIN Animal father ON father.idAnimal = preg.Animal_idAnimalPai
    LEFT JOIN TipoPrenhez method ON method.idTipoPrenhez = preg.TipoPrenhez_idTipoPrenhez
    LEFT JOIN TipoParto birthType ON birthType.idTipoParto = preg.TipoParto_idTipoParto
    WHERE a.Pecuaria = 1 AND ${scope.sql}
    ORDER BY CASE preg.Status WHEN 'Prenhez Pendente' THEN 0 WHEN 'Prenhez Confirmada' THEN 1 ELSE 2 END,
      preg.DataParto, mother.Brinco COLLATE NOCASE
  `).all(...scope.params));
  return res.status(status).render('pregnancies', {
    pageTitle: view === 'available' ? 'Prenhezes (Fêmeas Vazias)' : 'Confirmação e Parto',
    view, pregnancies, availableFemales, heifersNearCoverage, error
  });
}

async function renderNewPregnancy(res, user, animal, error = null, status = 200, formValues = {}) {
  const sires = (await pregnancySires(user, animal.Propriedade_idPropriedade));
  const methods = (await db.prepare('SELECT idTipoPrenhez, Nome FROM TipoPrenhez WHERE Ativo = 1 ORDER BY Nome COLLATE NOCASE').all());
  return res.status(status).render('pregnancy-form', {
    pageTitle: 'Registrar prenhez', mode: 'new', animal, sires, methods, error,
    formValues: { ...formValues, pregnancyDate: formValues.pregnancyDate ?? new Date().toISOString().slice(0, 10) }
  });
}

function renderPregnancyConfirmation(res, pregnancy, error = null, status = 200, formValues = {}, mode = 'confirm') {
  const pregnancyDate = formValues.pregnancyDate ?? pregnancy.DataPrenhez ?? new Date().toISOString().slice(0, 10);
  const confirmationDateValue = formValues.confirmationDate || pregnancy.DataConfirmacao || new Date().toISOString().slice(0, 10);
  const confirmationDate = isValidIsoDate(confirmationDateValue)
    ? confirmationDateValue
    : pregnancy.DataConfirmacao || new Date().toISOString().slice(0, 10);
  const daysPregnantRaw = String(formValues.daysPregnant ?? pregnancy.DiasPrenhe ?? '').trim();
  const daysPregnant = daysPregnantRaw ? Number(daysPregnantRaw) : null;
  const referenceDate = isValidIsoDate(pregnancyDate) ? pregnancyDate : confirmationDate;
  const suggestedDueDate = Number.isInteger(daysPregnant) && daysPregnant >= 0
    ? addDaysToIsoDate(confirmationDate, pregnancy.DiasGestacao - daysPregnant)
    : addDaysToIsoDate(referenceDate, pregnancy.DiasGestacao);
  return res.status(status).render('pregnancy-form', {
    pageTitle: mode === 'forecast' ? 'Previsão do parto' : 'Confirmar prenhez', mode, pregnancy, error,
    formValues: { ...formValues, pregnancyDate, confirmationDate, daysPregnant: formValues.daysPregnant ?? pregnancy.DiasPrenhe ?? '', expectedCalvingDate: suggestedDueDate }
  });
}

async function renderCalvingForm(res, pregnancy, error = null, status = 200, formValues = {}) {
  const birthTypes = (await db.prepare(`
    SELECT idTipoParto, Nome, Quantidade FROM TipoParto WHERE Ativo = 1 ORDER BY Nome COLLATE NOCASE
  `).all());
  const selectedTypeId = Number(formValues.birthTypeId) || birthTypes[0]?.idTipoParto || null;
  const selectedType = birthTypes.find((item) => item.idTipoParto === selectedTypeId);
  return res.status(status).render('pregnancy-form', {
    pageTitle: 'Registrar parto', mode: 'birth', pregnancy, birthTypes,
    offspringCount: selectedType?.Quantidade || 0, error,
    formValues: { ...formValues, birthTypeId: selectedTypeId, birthDate: formValues.birthDate || pregnancy.DataParto || new Date().toISOString().slice(0, 10) }
  });
}

async function lactationPropertyOptions(user) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT DISTINCT prop.idPropriedade, prop.Nome, pr.Nome AS ProdutorNome
    FROM Propriedade prop
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN AtividadePropriedade ap ON ap.Propriedade_idPropriedade = prop.idPropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    WHERE ${scope.sql} AND a.Pecuaria = 1
    ORDER BY prop.Nome COLLATE NOCASE
  `).all(...scope.params));
}

async function renderLactations(res, user, filters = {}, error = null, status = 200) {
  const scope = producerScope(user, 'pr');
  const properties = (await lactationPropertyOptions(user));
  const requestedPropertyId = Number(filters.propertyId);
  const propertyId = Number.isInteger(requestedPropertyId) && properties.some((property) => property.idPropriedade === requestedPropertyId)
    ? requestedPropertyId
    : null;
  const conditions = [scope.sql, 'a.Pecuaria = 1'];
  const params = [...scope.params];
  if (propertyId) {
    conditions.push('prop.idPropriedade = ?');
    params.push(propertyId);
  }
  const lactations = (await db.prepare(`
    SELECT lact.*, animal.Brinco, animal.StatusReprodutivo, prop.idPropriedade, prop.Nome AS PropriedadeNome,
      pr.Nome AS ProdutorNome, category.Nome AS CategoriaNome
    FROM Lactacoes lact
    JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    LEFT JOIN Categoria category ON category.idCategoria = animal.Categoria_idCategoria
    WHERE ${conditions.join(' AND ')}
    ORDER BY lact.Termino IS NULL DESC, lact.Inicio DESC, animal.Brinco COLLATE NOCASE
  `).all(...params));
  return res.status(status).render('lactations', {
    pageTitle: 'Lactações', lactations, properties, propertyId, error,
    success: filters.dried === '1' ? 'Secagem registrada; o animal está vazio.' : filters.updated === '1' ? 'Registro da lactação atualizado.' : null
  });
}

async function renderDailyMilk(res, user, filters = {}, error = null, status = 200) {
  const scope = producerScope(user, 'pr');
  const properties = (await lactationPropertyOptions(user));
  const requestedPropertyId = Number(filters.propertyId);
  const propertyId = Number.isInteger(requestedPropertyId) && properties.some((property) => property.idPropriedade === requestedPropertyId)
    ? requestedPropertyId
    : null;
  const today = new Date().toISOString().slice(0, 10);
  let productionDate = String(filters.date || today);
  if (!isValidIsoDate(productionDate) || productionDate > today) {
    productionDate = today;
    error = error || 'Selecione uma data válida, atual ou passada.';
  }
  const conditions = ['lact.Inicio <= ?', '(lact.Termino IS NULL OR lact.Termino >= ?)', "animal.Sexo = 'F'", 'a.Pecuaria = 1', scope.sql];
  const params = [productionDate, productionDate, ...scope.params];
  if (propertyId) {
    conditions.push('prop.idPropriedade = ?');
    params.push(propertyId);
  }
  const dailyLactations = (await db.prepare(`
    SELECT lact.idLactacoes, lact.Inicio, animal.idAnimal, animal.Brinco,
      prop.idPropriedade, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome,
      milk.Quantidade
    FROM Lactacoes lact
    JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    LEFT JOIN Lancamentos milk ON milk.Lactacoes_idLactacoes = lact.idLactacoes AND milk.DataLancamento = ?
    WHERE ${conditions.join(' AND ')}
    ORDER BY prop.Nome COLLATE NOCASE, animal.Brinco COLLATE NOCASE
  `).all(productionDate, ...params));
  return res.status(status).render('daily-milk', {
    pageTitle: 'Produção Diária', dailyLactations, properties, propertyId, productionDate,
    error,
    success: filters.saved === '1' ? 'Lançamentos de leite salvos.' : null
  });
}

async function loadLactationForUser(lactationId, user) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT lact.*, animal.idAnimal, animal.Brinco, animal.Nascimento, animal.Prenhez_idPrenhez,
      prop.idPropriedade, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome
    FROM Lactacoes lact
    JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE lact.idLactacoes = ? AND a.Pecuaria = 1 AND ${scope.sql}
  `).get(lactationId, ...scope.params));
}

function renderLactationEdit(res, lactation, error = null, status = 200, formValues = {}) {
  return res.status(status).render('lactation-edit', {
    pageTitle: 'Editar lactação', lactation, error,
    formValues: {
      startDate: formValues.startDate ?? lactation.Inicio,
      endDate: formValues.endDate ?? lactation.Termino ?? ''
    }
  });
}

async function lactationAnimals(user) {
  const scope = producerScope(user, 'pr');
  return (await db.prepare(`
    SELECT animal.idAnimal, animal.Brinco, animal.Nascimento, prop.Nome AS PropriedadeNome,
      pr.Nome AS ProdutorNome
    FROM Animal animal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE a.Pecuaria = 1 AND a.Ativo = 1 AND ap.Ativo = 1 AND prop.Ativo = 1
      AND animal.Sexo = 'F' AND animal.PertenceRebanho = 1 AND animal.DataSaida IS NULL
      AND animal.Prenhez_idPrenhez IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM Lactacoes active
        WHERE active.Animal_idAnimal = animal.idAnimal AND active.Termino IS NULL
      )
      AND ${scope.sql}
    ORDER BY prop.Nome COLLATE NOCASE, animal.Brinco COLLATE NOCASE
  `).all(...scope.params));
}

async function renderNewLactation(res, user, error = null, status = 200, formValues = {}) {
  return res.status(status).render('lactation-form', {
    pageTitle: 'Nova lactação', animals: (await lactationAnimals(user)), error,
    formValues: { ...formValues, startDate: formValues.startDate || new Date().toISOString().slice(0, 10) }
  });
}

async function renderProductions(res, user, filters = {}, error = null, status = 200, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const activityFlag = moduleOrigin === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  const activityLabel = moduleOrigin === 'pecuaria' ? 'pecuária' : 'agrícola';
  const associations = (await propertyAssociations(user)).filter((association) => association.Ativo === 1);
  const availableProperties = (await productionPropertyOptions(user, moduleOrigin));
  const associationIds = associations.map((association) => association.idCooperativaAssociacao);
  let associationId = Number(filters.associationId) || null;
  if (user.Perfil !== 'Administrador' && associationId && !associationIds.includes(associationId)) associationId = null;
  const products = (await db.prepare(`
    SELECT p.idProduto, p.Nome, u.Sigla AS UnidadeSigla
    FROM Produto p JOIN Atividade a ON a.idAtividade = p.Atividade_idAtividade
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    WHERE p.Ativo = 1 AND a.Ativo = 1 AND a.${activityFlag} = 1 AND u.Ativo = 1
    ORDER BY p.Nome COLLATE NOCASE
  `).all());
  let productId = Number(filters.productId) || null;
  if (productId && !products.some((product) => product.idProduto === productId)) productId = null;
  let propertyId = Number(filters.propertyId) || null;
  if (propertyId && !availableProperties.some((property) => property.idPropriedade === propertyId)) propertyId = null;

  const scope = producerScope(user, 'pr');
  const conditions = [scope.sql, `a.${activityFlag} = 1`];
  const params = [...scope.params];
  if (associationId) {
    conditions.push('ca.idCooperativaAssociacao = ?');
    params.push(associationId);
  } else if (user.Perfil === 'Gestor' && associationIds.length) {
    conditions.push(`ca.idCooperativaAssociacao IN (${associationIds.map(() => '?').join(', ')})`);
    params.push(...associationIds);
  } else if (user.Perfil === 'Gestor') {
    conditions.push('0 = 1');
  }
  if (productId) {
    conditions.push('prod.idProduto = ?');
    params.push(productId);
  }
  if (propertyId) {
    conditions.push('prop.idPropriedade = ?');
    params.push(propertyId);
  }
  if (filters.situation && ['Planejada', 'Realizada'].includes(filters.situation)) {
    conditions.push('p.Situacao = ?');
    params.push(filters.situation);
  } else {
    conditions.push("p.Situacao <> 'Cancelada'");
  }
  const fromWhere = `
    FROM Producao p
    JOIN Produto prod ON prod.idProduto = p.Produto_idProduto
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    LEFT JOIN TalhaoArea t ON t.idTalhaoArea = p.TalhaoArea_idTalhaoArea
    LEFT JOIN (
      SELECT Producao_idProducao, SUM(Quantidade) AS QuantidadeEntregue, MIN(DataEntrega) AS PrimeiraEntrega
      FROM Entrega GROUP BY Producao_idProducao
    ) e ON e.Producao_idProducao = p.IdProducao
    WHERE ${conditions.join(' AND ')}
  `;
  const productions = (await db.prepare(`
    SELECT p.IdProducao, p.Situacao, p.InicioProducao, p.PrevisaoProducao, p.AreaPlanejada, p.Previsao, p.Realizado, p.Descricao,
      prod.Nome AS ProdutoNome, u.Sigla AS UnidadeSigla, prop.idPropriedade AS Propriedade_idPropriedade, prop.Nome AS PropriedadeNome,
      pr.Nome AS ProdutorNome, ca.Nome AS AssociacaoNome, sp.Descricao AS SafraNome,
      COALESCE(NULLIF(trim(ap.Descricao), ''), a.Descricao || ' · ' || sp.Descricao) AS AtividadeNome,
      t.Descricao AS TalhaoNome, COALESCE(e.QuantidadeEntregue, 0) AS QuantidadeEntregue, e.PrimeiraEntrega
    ${fromWhere}
    ORDER BY prod.Nome COLLATE NOCASE, COALESCE(p.PrevisaoProducao, p.InicioProducao, '9999-12-31'), prop.Nome COLLATE NOCASE
  `).all(...params));
  const totals = (await db.prepare(`
    SELECT COUNT(*) AS Producoes, COALESCE(SUM(p.Previsao), 0) AS Previsto,
      COALESCE(SUM(p.Realizado), 0) AS Realizado, COALESCE(SUM(e.QuantidadeEntregue), 0) AS Entregue
    ${fromWhere}
  `).get(...params));
  return res.status(status).render('productions', {
    pageTitle: 'Produções', associations, products, productions, totals,
    associationId, productId, propertyId, situation: filters.situation || '', availableProperties, error, moduleOrigin, activityLabel,
    moduleBasePath: productionModuleBasePath(moduleOrigin)
  });
}

async function productionPropertyOptions(user, moduleOrigin = 'agricultura') {
  const scope = producerScope(user, 'pr');
  const activityFlag = normalizePropertyModule(moduleOrigin) === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  return (await db.prepare(`
    SELECT prop.idPropriedade, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome,
      ca.Nome AS AssociacaoNome
    FROM Propriedade prop JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN Usuario u ON u.idUsuario = pr.Usuario_idUsuario
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    WHERE ${scope.sql} AND prop.Ativo = 1 AND pr.Ativo = 1 AND u.Situacao = 'Ativo' AND ca.Ativo = 1
      AND EXISTS (
        SELECT 1 FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
        WHERE ap.Propriedade_idPropriedade = prop.idPropriedade AND ap.Ativo = 1 AND a.Ativo = 1 AND a.${activityFlag} = 1
      )
    ORDER BY ca.Nome COLLATE NOCASE, prop.Nome COLLATE NOCASE
  `).all(...scope.params));
}

async function productionEditorOptions(user, current = null, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const activityFlag = moduleOrigin === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  const properties = (await productionPropertyOptions(user, moduleOrigin));
  if (current && !properties.some((property) => property.idPropriedade === current.Propriedade_idPropriedade)) {
    const currentProperty = (await loadProperty(current.Propriedade_idPropriedade));
    if (currentProperty && (await propertyIsAccessible(user, currentProperty))) {
      properties.push({
        idPropriedade: currentProperty.idPropriedade,
        PropriedadeNome: currentProperty.Nome,
        ProdutorNome: currentProperty.ProdutorNome,
        AssociacaoNome: currentProperty.AssociacaoNome,
        Ativo: currentProperty.Ativo
      });
    }
  }
  const propertyIds = properties.map((property) => property.idPropriedade);
  if (!propertyIds.length) return { properties, activities: [], talhoes: [], products: [] };
  const placeholders = propertyIds.map(() => '?').join(', ');
  const currentActivityId = current?.AtividadePropriedade_idAtividadePropriedade || -1;
  const activities = (await db.prepare(`
    SELECT ap.idAtividadePropriedade, ap.Propriedade_idPropriedade, ap.Atividade_idAtividade,
      COALESCE(NULLIF(trim(ap.Descricao), ''), a.Descricao || ' · ' || sp.Descricao) AS Descricao,
      ap.Ativo, a.Agricultura, a.Ativo AS AtividadeAtiva, sp.Ativo AS SafraAtiva
    FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    WHERE ap.Propriedade_idPropriedade IN (${placeholders}) AND a.${activityFlag} = 1
      AND (ap.idAtividadePropriedade = ? OR (ap.Ativo = 1 AND a.Ativo = 1 AND sp.Ativo = 1))
    ORDER BY ap.Propriedade_idPropriedade, sp.Inicio DESC, a.Descricao COLLATE NOCASE
  `).all(...propertyIds, currentActivityId));
  const currentTalhaoId = current?.TalhaoArea_idTalhaoArea || -1;
  const talhoes = moduleOrigin === 'agricultura' ? (await db.prepare(`
    SELECT t.idTalhaoArea, t.Propriedade_idPropriedade, t.Descricao, t.Area,
      t.UnidadeArea_idUnidadeArea, t.Ativo, ua.Sigla AS UnidadeSigla
    FROM TalhaoArea t LEFT JOIN UnidadeArea ua ON ua.idUnidadeArea = t.UnidadeArea_idUnidadeArea
    WHERE t.Propriedade_idPropriedade IN (${placeholders}) AND (t.Ativo = 1 OR t.idTalhaoArea = ?)
    ORDER BY t.Propriedade_idPropriedade, t.Descricao COLLATE NOCASE
  `).all(...propertyIds, currentTalhaoId)) : [];
  const currentProductId = current?.Produto_idProduto || -1;
  const products = (await db.prepare(`
    SELECT p.idProduto, p.Nome AS ProdutoNome, p.Atividade_idAtividade, p.Ativo AS ProdutoAtivo,
      a.Descricao AS AtividadeNome, a.${activityFlag} AS IsModuleActivity, a.Ativo AS AtividadeAtiva,
      u.idUnidade, u.Nome AS UnidadeNome, u.Sigla AS UnidadeSigla, u.Ativo AS UnidadeAtiva
    FROM Produto p
    JOIN Atividade a ON a.idAtividade = p.Atividade_idAtividade
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    WHERE a.${activityFlag} = 1 AND (p.idProduto = ? OR (p.Ativo = 1 AND a.Ativo = 1 AND u.Ativo = 1))
    ORDER BY p.Nome COLLATE NOCASE
  `).all(currentProductId));
  return { properties, activities, talhoes, products };
}

async function renderProductionForm(res, user, production = null, error = null, status = 200, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const options = (await productionEditorOptions(user, production, moduleOrigin));
  return res.status(status).render('production-form', {
    pageTitle: production ? 'Editar produção' : 'Nova produção',
    production, existing: Boolean(production), error, moduleOrigin, activityLabel: moduleOrigin === 'pecuaria' ? 'pecuária' : 'agrícola',
    moduleBasePath: productionModuleBasePath(moduleOrigin), ...options
  });
}

function productionModuleBasePath(moduleOrigin) {
  return normalizePropertyModule(moduleOrigin) === 'pecuaria' ? '/pecuaria/producoes' : '/agricultura/producoes';
}

function productionModuleFromRequest(req) {
  return req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura';
}

app.get(['/agricultura/producoes/nova', '/pecuaria/producoes/nova'], requireAuth, async (req, res) => {
  return (await renderProductionForm(res, req.user, null, null, 200, productionModuleFromRequest(req)));
});

app.post(['/agricultura/producoes', '/pecuaria/producoes'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const fields = (await validateProductionFields(req.body, req.user, null, moduleOrigin));
  if (fields.error) return (await renderProductionForm(res, req.user, null, fields.error, 400, moduleOrigin));
  try {
    (await db.prepare(`
      INSERT INTO Producao
        (Unidade_idUnidade, Produto_idProduto, TalhaoArea_idTalhaoArea, AreaPlanejada,
         AtividadePropriedade_idAtividadePropriedade, InicioProducao, PrevisaoProducao, Previsao, Realizado, Situacao, Descricao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fields.unitId, fields.productId, fields.talhaoId, fields.plannedArea, fields.activityPropertyId,
      fields.startDate, fields.forecastDate, fields.forecast, fields.realized, fields.situation, fields.description || null));
    return res.redirect(moduleBasePath);
  } catch {
    return (await renderProductionForm(res, req.user, null, 'Não foi possível registrar a produção.', 400, moduleOrigin));
  }
});

app.get(['/agricultura/producoes/:id', '/pecuaria/producoes/:id'], requireAuth, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  return (await renderProductionForm(res, req.user, production, null, 200, moduleOrigin));
});

app.post(['/agricultura/producoes/:id/atualizar', '/pecuaria/producoes/:id/atualizar'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  const fields = (await validateProductionFields(req.body, req.user, production, moduleOrigin));
  if (fields.error) return (await renderProductionForm(res, req.user, production, fields.error, 400, moduleOrigin));
  const existingDeliveries = (await db.prepare('SELECT COUNT(*) AS total FROM Entrega WHERE Producao_idProducao = ?').get(production.IdProducao)).total;
  if (existingDeliveries && (fields.propertyId !== production.Propriedade_idPropriedade || fields.productId !== production.Produto_idProduto)) {
    return (await renderProductionForm(res, req.user, production, 'Não é possível trocar propriedade ou produto após registrar entregas.', 400, moduleOrigin));
  }
  try {
    (await db.prepare(`
      UPDATE Producao SET Unidade_idUnidade = ?, Produto_idProduto = ?,
        TalhaoArea_idTalhaoArea = ?, AreaPlanejada = ?, AtividadePropriedade_idAtividadePropriedade = ?,
        InicioProducao = ?, PrevisaoProducao = ?, Previsao = ?, Realizado = ?, Situacao = ?, Descricao = ?
      WHERE IdProducao = ?
    `).run(fields.unitId, fields.productId, fields.talhaoId, fields.plannedArea, fields.activityPropertyId,
      fields.startDate, fields.forecastDate, fields.forecast, fields.realized, fields.situation,
      fields.description || null, production.IdProducao));
    return res.redirect(`${moduleBasePath}/${production.IdProducao}`);
  } catch {
    return (await renderProductionForm(res, req.user, production, 'Não foi possível atualizar a produção.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/producoes/:id/excluir', '/pecuaria/producoes/:id/excluir'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  try {
    (await db.prepare('DELETE FROM Producao WHERE IdProducao = ?').run(production.IdProducao));
    return res.redirect(moduleBasePath);
  } catch {
    return (await renderProductionForm(res, req.user, production, 'Esta produção tem Entregas vinculadas. Remova-as para excluir ou mantenha a produção no histórico.', 400, moduleOrigin));
  }
});

app.get(['/agricultura/producoes', '/pecuaria/producoes'], requireAuth, async (req, res) => {
  return (await renderProductions(res, req.user, req.query, null, 200, productionModuleFromRequest(req)));
});

async function renderPropertyList(res, user, associationFilter = '', error = null, status = 200, livestockOnly = false) {
  const associations = (await propertyAssociations(user));
  const producerOptions = (await propertyProducerOptions(user));
  const livestockCondition = `EXISTS (
    SELECT 1 FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    WHERE ap.Propriedade_idPropriedade = p.idPropriedade AND ap.Ativo = 1 AND a.Pecuaria = 1 AND a.Ativo = 1
  )`;
  const validAssociationIds = associations.map((association) => association.idCooperativaAssociacao);
  let selectedAssociationId = Number(associationFilter) || null;
  if (user.Perfil !== 'Administrador' && selectedAssociationId && !validAssociationIds.includes(selectedAssociationId)) {
    selectedAssociationId = null;
  }
  let properties = [];
  if (user.Perfil === 'Administrador') {
    const params = [];
    const conditions = [];
    if (selectedAssociationId) {
      conditions.push('p.Produtor_idProdutor IN (SELECT idProdutor FROM Produtor WHERE CooperativaAssociacao_idCooperativaAssociacao = ?)');
      params.push(selectedAssociationId);
    }
    if (livestockOnly) conditions.push(livestockCondition);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    properties = (await db.prepare(`
      SELECT p.idPropriedade, p.Nome, p.AreaTotal, p.Ativo, pr.Nome AS ProdutorNome,
        ca.Nome AS AssociacaoNome, m.Nome AS MunicipioNome, e.Sigla AS EstadoSigla
      FROM Propriedade p JOIN Produtor pr ON pr.idProdutor = p.Produtor_idProdutor
      JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
      JOIN Municipio m ON m.idMunicipio = p.Municipio_idMunicipio
      JOIN Estado e ON e.idEstado = m.Estado_idEstado
      ${where} ORDER BY ca.Nome COLLATE NOCASE, p.Nome COLLATE NOCASE
    `).all(...params));
  } else if (user.Perfil === 'Produtor') {
    properties = (await db.prepare(`
      SELECT p.idPropriedade, p.Nome, p.AreaTotal, p.Ativo, pr.Nome AS ProdutorNome,
        ca.Nome AS AssociacaoNome, m.Nome AS MunicipioNome, e.Sigla AS EstadoSigla
      FROM Propriedade p JOIN Produtor pr ON pr.idProdutor = p.Produtor_idProdutor
      JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
      JOIN Municipio m ON m.idMunicipio = p.Municipio_idMunicipio
      JOIN Estado e ON e.idEstado = m.Estado_idEstado
      WHERE pr.Usuario_idUsuario = ? ${livestockOnly ? `AND ${livestockCondition}` : ''} ORDER BY p.Nome COLLATE NOCASE
    `).all(user.idUsuario));
  } else if (validAssociationIds.length) {
    const params = [...validAssociationIds];
    let where = `WHERE pr.CooperativaAssociacao_idCooperativaAssociacao IN (${validAssociationIds.map(() => '?').join(', ')})`;
    if (selectedAssociationId) {
      where += ' AND pr.CooperativaAssociacao_idCooperativaAssociacao = ?';
      params.push(selectedAssociationId);
    }
    if (livestockOnly) where += ` AND ${livestockCondition}`;
    properties = (await db.prepare(`
      SELECT p.idPropriedade, p.Nome, p.AreaTotal, p.Ativo, pr.Nome AS ProdutorNome,
        ca.Nome AS AssociacaoNome, m.Nome AS MunicipioNome, e.Sigla AS EstadoSigla
      FROM Propriedade p JOIN Produtor pr ON pr.idProdutor = p.Produtor_idProdutor
      JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
      JOIN Municipio m ON m.idMunicipio = p.Municipio_idMunicipio
      JOIN Estado e ON e.idEstado = m.Estado_idEstado
      ${where} ORDER BY ca.Nome COLLATE NOCASE, p.Nome COLLATE NOCASE
    `).all(...params));
  }
  return res.status(status).render('properties', {
    pageTitle: livestockOnly ? 'Propriedades pecuárias' : 'Propriedades',
    properties, associations, producerOptions, selectedAssociationId, error, livestockOnly
  });
}

async function loadProperty(propertyId) {
  return (await db.prepare(`
    SELECT p.*, pr.Nome AS ProdutorNome, pr.CooperativaAssociacao_idCooperativaAssociacao,
      ca.Nome AS AssociacaoNome, m.Nome AS MunicipioNome, e.Sigla AS EstadoSigla
    FROM Propriedade p JOIN Produtor pr ON pr.idProdutor = p.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    JOIN Municipio m ON m.idMunicipio = p.Municipio_idMunicipio
    JOIN Estado e ON e.idEstado = m.Estado_idEstado
    WHERE p.idPropriedade = ?
  `).get(propertyId));
}

function normalizePropertyModule(value) {
  return String(value || '').toLowerCase() === 'pecuaria' ? 'pecuaria' : 'agricultura';
}

function propertyModuleListPath(moduleOrigin) {
  return `${propertyModuleBasePath(moduleOrigin)}`;
}

function propertyModuleBasePath(moduleOrigin) {
  return normalizePropertyModule(moduleOrigin) === 'pecuaria' ? '/pecuaria/propriedades' : '/agricultura/propriedades';
}

function propertyEditorPath(propertyId, tab, moduleOrigin) {
  const basePath = propertyModuleBasePath(moduleOrigin);
  return `${basePath}/${propertyId}?aba=${tab}`;
}

async function renderPropertyEditor(res, user, property, tab = 'dados', error = null, status = 200, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const activityType = moduleOrigin === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  const existing = Boolean(property?.idPropriedade);
  const producerOptions = (await propertyProducerOptions(user, property?.Produtor_idProdutor ?? null));
  const municipalities = (await db.prepare(`
    SELECT m.idMunicipio, m.Nome, e.Sigla, e.Nome AS EstadoNome, m.Ativo, e.Ativo AS EstadoAtivo
    FROM Municipio m JOIN Estado e ON e.idEstado = m.Estado_idEstado
    WHERE (m.Ativo = 1 AND e.Ativo = 1) OR m.idMunicipio = ?
    ORDER BY e.Nome COLLATE NOCASE, m.Nome COLLATE NOCASE
  `).all(property?.Municipio_idMunicipio || -1));
  const areaUnits = (await db.prepare('SELECT idUnidadeArea, Nome, Sigla, Ativo FROM UnidadeArea ORDER BY Nome COLLATE NOCASE').all());
  const activities = existing ? (await db.prepare(`
    SELECT ap.idAtividadePropriedade, ap.SafraPeriodo_idSafraPeriodo, ap.Atividade_idAtividade,
      ap.IdadeCobertura, ap.AreaUtilizada, ap.UnidadeArea_idUnidadeArea, ap.Descricao, ap.Ativo,
      a.Descricao AS AtividadeNome, a.Pecuaria AS AtividadePecuaria, sp.Descricao AS SafraNome, ua.Sigla AS UnidadeSigla
    FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    LEFT JOIN UnidadeArea ua ON ua.idUnidadeArea = ap.UnidadeArea_idUnidadeArea
    WHERE ap.Propriedade_idPropriedade = ? AND a.${activityType} = 1 ORDER BY sp.Inicio DESC, a.Descricao COLLATE NOCASE
  `).all(property.idPropriedade)) : [];
  const activityOptions = (await db.prepare(`
    SELECT idAtividade, Descricao, Ativo, Agricultura, Pecuaria FROM Atividade
    WHERE ${activityType} = 1 AND (Ativo = 1 OR idAtividade IN (
      SELECT ap.Atividade_idAtividade FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
      WHERE ap.Propriedade_idPropriedade = ? AND a.${activityType} = 1
    )) ORDER BY Descricao COLLATE NOCASE
  `).all(property?.idPropriedade || -1));
  const seasonOptions = (await db.prepare(`
    SELECT idSafraPeriodo, Descricao, Ativo FROM SafraPeriodo
    WHERE Ativo = 1 OR idSafraPeriodo IN (
      SELECT SafraPeriodo_idSafraPeriodo FROM AtividadePropriedade WHERE Propriedade_idPropriedade = ?
    ) ORDER BY Inicio DESC, Descricao COLLATE NOCASE
  `).all(property?.idPropriedade || -1));
  const talhoes = existing ? (await db.prepare(`
    SELECT t.idTalhaoArea, t.Descricao, t.Area, t.UnidadeArea_idUnidadeArea, t.Ativo, ua.Nome AS UnidadeNome, ua.Sigla AS UnidadeSigla
    FROM TalhaoArea t LEFT JOIN UnidadeArea ua ON ua.idUnidadeArea = t.UnidadeArea_idUnidadeArea
    WHERE t.Propriedade_idPropriedade = ? ORDER BY t.Descricao COLLATE NOCASE
  `).all(property.idPropriedade)) : [];
  return res.status(status).render('property', {
    pageTitle: existing ? property.Nome : 'Nova propriedade', property, existing, tab,
    producerOptions, municipalities, areaUnits, activities, activityOptions, seasonOptions, talhoes,
    error, moduleOrigin
  });
}

async function validatePropertyFields(body, user, current = null) {
  const producerId = Number(body.producerId);
  const producer = (await propertyProducerOptions(user, current?.Produtor_idProdutor ?? null)).find((item) => item.idProdutor === producerId);
  if (!producer) return { error: 'Selecione um Produtor disponível para sua associação.' };
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 150) return { error: 'Informe um nome de propriedade válido.' };
  const municipalityId = Number(body.municipalityId);
  const municipality = (await db.prepare('SELECT Ativo, Estado_idEstado FROM Municipio WHERE idMunicipio = ?').get(municipalityId));
  const state = municipality && (await db.prepare('SELECT Ativo FROM Estado WHERE idEstado = ?').get(municipality.Estado_idEstado));
  if (!municipality || (!municipality.Ativo || !state?.Ativo) && municipalityId !== current?.Municipio_idMunicipio) {
    return { error: 'Selecione um Município e Estado ativos.' };
  }
  const areaUnitId = body.areaUnitId ? Number(body.areaUnitId) : null;
  if (areaUnitId !== null) {
    const unit = (await db.prepare('SELECT Ativo FROM UnidadeArea WHERE idUnidadeArea = ?').get(areaUnitId));
    if (!unit || (!unit.Ativo && areaUnitId !== current?.UnidadeArea_idUnidadeArea)) return { error: 'Selecione uma unidade de área ativa.' };
  }
  const areaRaw = String(body.areaTotal || '').trim();
  const areaTotal = areaRaw ? Number(areaRaw) : null;
  if (areaRaw && (!Number.isFinite(areaTotal) || areaTotal < 0)) return { error: 'A área total deve ser um número igual ou maior que zero.' };
  const gestationDays = Number(body.gestationDays ?? current?.DiasGestacao ?? DEFAULT_GESTATION_DAYS);
  if (!Number.isInteger(gestationDays) || gestationDays < 1 || gestationDays > 400) {
    return { error: 'A duração da gestação deve ser um número inteiro entre 1 e 400 dias.' };
  }
  const fields = {
    producerId, municipalityId, name, areaUnitId, areaTotal, gestationDays,
    whatsapp: String(body.whatsapp || '').trim(),
    contact: String(body.contact || '').trim(),
    contactPhone: String(body.contactPhone || '').trim(),
    location: String(body.location || '').trim()
  };
  if ([fields.whatsapp, fields.contact, fields.contactPhone, fields.location].some((value) => value.length > 250)) {
    return { error: 'Um dos campos de contato excede o limite permitido.' };
  }
  return fields;
}

async function propertyActivityAccess(propertyId, user) {
  const property = (await loadProperty(propertyId));
  return property && (await propertyIsAccessible(user, property)) ? property : null;
}

app.get('/agricultura/propriedades', requireAuth, async (req, res) => (await renderPropertyList(res, req.user, req.query.associacao || '')));
app.get('/pecuaria/propriedades', requireAuth, async (req, res) => (await renderPropertyList(res, req.user, req.query.associacao || '', null, 200, true)));
app.get(['/agricultura/propriedades/nova', '/pecuaria/propriedades/nova'], requireAuth, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.query.modulo || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  if (!(await propertyProducerOptions(req.user)).length) return (await renderPropertyList(res, req.user, '', 'Não há Produtores ativos disponíveis para cadastrar uma propriedade.', 400, moduleOrigin === 'pecuaria'));
  return (await renderPropertyEditor(res, req.user, null, 'dados', null, 200, moduleOrigin));
});

app.post(['/agricultura/propriedades', '/pecuaria/propriedades'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const fields = (await validatePropertyFields(req.body, req.user));
  if (fields.error) return (await renderPropertyEditor(res, req.user, null, 'dados', fields.error, 400, moduleOrigin));
  try {
    const result = (await db.prepare(`
      INSERT INTO Propriedade
        (Produtor_idProdutor, Municipio_idMunicipio, Nome, Fone_Whats, Contato, Fone_Contato, Localizacao, AreaTotal, UnidadeArea_idUnidadeArea, DiasGestacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fields.producerId, fields.municipalityId, fields.name, fields.whatsapp || null, fields.contact || null,
      fields.contactPhone || null, fields.location || null, fields.areaTotal, fields.areaUnitId, fields.gestationDays));
    return res.redirect(propertyEditorPath(result.lastInsertRowid, 'dados', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, null, 'dados', 'Não foi possível criar a propriedade.', 400, moduleOrigin));
  }
});

app.get(['/agricultura/propriedades/:id', '/pecuaria/propriedades/:id'], requireAuth, async (req, res) => {
  const property = (await loadProperty(Number(req.params.id)));
  if (!property || !(await propertyIsAccessible(req.user, property))) {
    return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não existe ou não está disponível para seu perfil.' });
  }
  const requestedTab = String(req.query.aba || 'dados');
  const tab = ['dados', 'atividades', 'talhoes'].includes(requestedTab) ? requestedTab : 'dados';
  const moduleOrigin = req.query.modulo || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura');
  return (await renderPropertyEditor(res, req.user, property, tab, null, 200, moduleOrigin));
});

app.post(['/agricultura/propriedades/:id/atualizar', '/pecuaria/propriedades/:id/atualizar'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const current = (await loadProperty(propertyId));
  if (!current || !(await propertyIsAccessible(req.user, current))) {
    return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não existe ou não está disponível para seu perfil.' });
  }
  const fields = (await validatePropertyFields(req.body, req.user, current));
  const active = String(req.body.active || '');
  if (fields.error) return (await renderPropertyEditor(res, req.user, current, 'dados', fields.error, 400, moduleOrigin));
  if (!['0', '1'].includes(active)) return (await renderPropertyEditor(res, req.user, current, 'dados', 'Selecione uma situação válida.', 400, moduleOrigin));
  try {
    (await db.prepare(`
      UPDATE Propriedade SET Produtor_idProdutor = ?, Municipio_idMunicipio = ?, Nome = ?, Fone_Whats = ?,
        Contato = ?, Fone_Contato = ?, Localizacao = ?, AreaTotal = ?, UnidadeArea_idUnidadeArea = ?, DiasGestacao = ?, Ativo = ?
      WHERE idPropriedade = ?
    `).run(fields.producerId, fields.municipalityId, fields.name, fields.whatsapp || null, fields.contact || null,
      fields.contactPhone || null, fields.location || null, fields.areaTotal, fields.areaUnitId, fields.gestationDays, Number(active), propertyId));
    return res.redirect(propertyEditorPath(propertyId, 'dados', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, current, 'dados', 'Não foi possível atualizar a propriedade.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/propriedades/:id/excluir', '/pecuaria/propriedades/:id/excluir'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const property = (await loadProperty(Number(req.params.id)));
  if (!property || !(await propertyIsAccessible(req.user, property))) {
    return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não existe ou não está disponível para seu perfil.' });
  }
  try {
    (await db.prepare('DELETE FROM Propriedade WHERE idPropriedade = ?').run(property.idPropriedade));
    return res.redirect(propertyModuleListPath(moduleOrigin));
  } catch (error) {
    const message = ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER'].includes(error.code)
      ? 'Esta propriedade possui atividades, talhões ou produção vinculados. Inative-a para preservar o histórico.'
      : 'Não foi possível excluir a propriedade.';
    return (await renderPropertyEditor(res, req.user, property, 'dados', message, 400, moduleOrigin));
  }
});

async function validatePropertyActivity(body, current = null, moduleOrigin = 'agricultura') {
  const activityId = Number(body.activityId);
  const activity = Number.isInteger(activityId) ? (await db.prepare('SELECT Agricultura, Pecuaria, Ativo FROM Atividade WHERE idAtividade = ?').get(activityId)) : null;
  const activityType = normalizePropertyModule(moduleOrigin) === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  if (!activity || activity[activityType] !== 1 || (activity.Ativo !== 1 && activityId !== current?.Atividade_idAtividade)) {
    return { error: `Selecione uma atividade ${activityType === 'Pecuaria' ? 'pecuária' : 'agrícola'} ativa.` };
  }
  const seasonId = Number(body.seasonId);
  const season = Number.isInteger(seasonId) ? (await db.prepare('SELECT Ativo FROM SafraPeriodo WHERE idSafraPeriodo = ?').get(seasonId)) : null;
  if (!season || (season.Ativo !== 1 && seasonId !== current?.SafraPeriodo_idSafraPeriodo)) return { error: 'Selecione uma safra ou período ativo.' };
  const unitId = body.areaUnitId ? Number(body.areaUnitId) : null;
  if (unitId !== null) {
    const unit = (await db.prepare('SELECT Ativo FROM UnidadeArea WHERE idUnidadeArea = ?').get(unitId));
    if (!unit || (!unit.Ativo && unitId !== current?.UnidadeArea_idUnidadeArea)) return { error: 'Selecione uma unidade de área ativa.' };
  }
  const parseOptional = (key, label) => {
    const raw = String(body[key] || '').trim();
    if (!raw) return { value: null };
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? { value } : { error: `${label} deve ser um número igual ou maior que zero.` };
  };
  const area = parseOptional('areaUsed', 'Área utilizada');
  if (area.error) return { error: area.error };
  const coverage = activity.Pecuaria === 1 ? parseOptional('coverageAge', 'Idade de cobertura') : { value: null };
  if (coverage.error) return { error: coverage.error };
  const description = String(body.description || '').trim();
  if (description.length > 500) return { error: 'A descrição excede 500 caracteres.' };
  return { activityId, seasonId, unitId, area: area.value, coverage: coverage.value, description };
}

app.post(['/agricultura/propriedades/:id/atividades', '/pecuaria/propriedades/:id/atividades'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const property = (await propertyActivityAccess(propertyId, req.user));
  if (!property) return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não está disponível para seu perfil.' });
  if (!property.Ativo) return (await renderPropertyEditor(res, req.user, property, 'atividades', 'Reative a propriedade antes de adicionar atividades.', 400, moduleOrigin));
  const fields = (await validatePropertyActivity(req.body, null, moduleOrigin));
  if (fields.error) return (await renderPropertyEditor(res, req.user, property, 'atividades', fields.error, 400, moduleOrigin));
  try {
    (await db.prepare(`
      INSERT INTO AtividadePropriedade
        (SafraPeriodo_idSafraPeriodo, Atividade_idAtividade, Propriedade_idPropriedade, IdadeCobertura, AreaUtilizada, UnidadeArea_idUnidadeArea, Descricao)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fields.seasonId, fields.activityId, propertyId, fields.coverage, fields.area, fields.unitId, fields.description || null));
    return res.redirect(propertyEditorPath(propertyId, 'atividades', moduleOrigin));
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'Esta atividade já está vinculada à propriedade nesta safra.'
      : 'Não foi possível vincular a atividade.';
    return (await renderPropertyEditor(res, req.user, property, 'atividades', message, 400, moduleOrigin));
  }
});

app.post(['/agricultura/propriedades/:id/atividades/:activityId/atualizar', '/pecuaria/propriedades/:id/atividades/:activityId/atualizar'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const activityPropertyId = Number(req.params.activityId);
  const property = (await propertyActivityAccess(propertyId, req.user));
  const current = (await db.prepare('SELECT * FROM AtividadePropriedade WHERE idAtividadePropriedade = ? AND Propriedade_idPropriedade = ?').get(activityPropertyId, propertyId));
  if (!property || !current) return res.status(404).render('error', { pageTitle: 'Atividade não encontrada', message: 'A atividade não está disponível para seu perfil.' });
  const fields = (await validatePropertyActivity(req.body, current, moduleOrigin));
  const active = String(req.body.active || '');
  if (fields.error) return (await renderPropertyEditor(res, req.user, property, 'atividades', fields.error, 400, moduleOrigin));
  if (!['0', '1'].includes(active)) return (await renderPropertyEditor(res, req.user, property, 'atividades', 'Selecione uma situação válida.', 400, moduleOrigin));
  try {
    (await db.prepare(`
      UPDATE AtividadePropriedade SET SafraPeriodo_idSafraPeriodo = ?, Atividade_idAtividade = ?,
        IdadeCobertura = ?, AreaUtilizada = ?, UnidadeArea_idUnidadeArea = ?, Descricao = ?, Ativo = ?
      WHERE idAtividadePropriedade = ? AND Propriedade_idPropriedade = ?
    `).run(fields.seasonId, fields.activityId, fields.coverage, fields.area, fields.unitId, fields.description || null,
      Number(active), activityPropertyId, propertyId));
    return res.redirect(propertyEditorPath(propertyId, 'atividades', moduleOrigin));
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'Esta atividade já está vinculada à propriedade nesta safra.'
      : 'Não foi possível atualizar a atividade.';
    return (await renderPropertyEditor(res, req.user, property, 'atividades', message, 400, moduleOrigin));
  }
});

app.post(['/agricultura/propriedades/:id/atividades/:activityId/excluir', '/pecuaria/propriedades/:id/atividades/:activityId/excluir'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const property = (await propertyActivityAccess(propertyId, req.user));
  if (!property) return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não está disponível para seu perfil.' });
  try {
    (await db.prepare('DELETE FROM AtividadePropriedade WHERE idAtividadePropriedade = ? AND Propriedade_idPropriedade = ?')
      .run(Number(req.params.activityId), propertyId));
    return res.redirect(propertyEditorPath(propertyId, 'atividades', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, property, 'atividades', 'Esta atividade possui produção ou animais vinculados. Inative-a para preservar o histórico.', 400, moduleOrigin));
  }
});

async function validateTalhao(body, current = null) {
  const description = String(body.description || '').trim();
  const area = Number(body.area);
  const areaUnitId = body.areaUnitId ? Number(body.areaUnitId) : null;
  if (description.length < 2 || description.length > 120) return { error: 'Informe uma descrição de talhão válida.' };
  if (!Number.isFinite(area) || area < 0) return { error: 'A área deve ser um número igual ou maior que zero.' };
  if (areaUnitId !== null) {
    const unit = (await db.prepare('SELECT Ativo FROM UnidadeArea WHERE idUnidadeArea = ?').get(areaUnitId));
    if (!unit || (!unit.Ativo && areaUnitId !== current?.UnidadeArea_idUnidadeArea)) return { error: 'Selecione uma unidade de área ativa.' };
  }
  return { description, area, areaUnitId };
}

app.post(['/agricultura/propriedades/:id/talhoes', '/pecuaria/propriedades/:id/talhoes'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const property = (await propertyActivityAccess(propertyId, req.user));
  if (!property) return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não está disponível para seu perfil.' });
  if (!property.Ativo) return (await renderPropertyEditor(res, req.user, property, 'talhoes', 'Reative a propriedade antes de adicionar talhões.', 400, moduleOrigin));
  const fields = (await validateTalhao(req.body));
  if (fields.error) return (await renderPropertyEditor(res, req.user, property, 'talhoes', fields.error, 400, moduleOrigin));
  try {
    (await db.prepare('INSERT INTO TalhaoArea (Propriedade_idPropriedade, Descricao, Area, UnidadeArea_idUnidadeArea) VALUES (?, ?, ?, ?)')
      .run(propertyId, fields.description, fields.area, fields.areaUnitId));
    return res.redirect(propertyEditorPath(propertyId, 'talhoes', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, property, 'talhoes', 'Não foi possível criar o talhão.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/propriedades/:id/talhoes/:talhaoId/atualizar', '/pecuaria/propriedades/:id/talhoes/:talhaoId/atualizar'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const talhaoId = Number(req.params.talhaoId);
  const property = (await propertyActivityAccess(propertyId, req.user));
  const current = (await db.prepare('SELECT * FROM TalhaoArea WHERE idTalhaoArea = ? AND Propriedade_idPropriedade = ?').get(talhaoId, propertyId));
  if (!property || !current) return res.status(404).render('error', { pageTitle: 'Talhão não encontrado', message: 'O talhão não está disponível para seu perfil.' });
  const fields = (await validateTalhao(req.body, current));
  const active = String(req.body.active || '');
  if (fields.error) return (await renderPropertyEditor(res, req.user, property, 'talhoes', fields.error, 400, moduleOrigin));
  if (!['0', '1'].includes(active)) return (await renderPropertyEditor(res, req.user, property, 'talhoes', 'Selecione uma situação válida.', 400, moduleOrigin));
  try {
    (await db.prepare('UPDATE TalhaoArea SET Descricao = ?, Area = ?, UnidadeArea_idUnidadeArea = ?, Ativo = ? WHERE idTalhaoArea = ? AND Propriedade_idPropriedade = ?')
      .run(fields.description, fields.area, fields.areaUnitId, Number(active), talhaoId, propertyId));
    return res.redirect(propertyEditorPath(propertyId, 'talhoes', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, property, 'talhoes', 'Não foi possível atualizar o talhão.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/propriedades/:id/talhoes/:talhaoId/excluir', '/pecuaria/propriedades/:id/talhoes/:talhaoId/excluir'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = normalizePropertyModule(req.body.moduleOrigin || (req.path.startsWith('/pecuaria/') ? 'pecuaria' : 'agricultura'));
  const propertyId = Number(req.params.id);
  const property = (await propertyActivityAccess(propertyId, req.user));
  if (!property) return res.status(404).render('error', { pageTitle: 'Propriedade não encontrada', message: 'A propriedade não está disponível para seu perfil.' });
  try {
    (await db.prepare('DELETE FROM TalhaoArea WHERE idTalhaoArea = ? AND Propriedade_idPropriedade = ?').run(Number(req.params.talhaoId), propertyId));
    return res.redirect(propertyEditorPath(propertyId, 'talhoes', moduleOrigin));
  } catch {
    return (await renderPropertyEditor(res, req.user, property, 'talhoes', 'Este talhão possui produção vinculada. Inative-o para preservar o histórico.', 400, moduleOrigin));
  }
});

function optionalQuantity(raw, label) {
  const valueText = String(raw ?? '').trim();
  if (!valueText) return { value: null };
  const value = Number(valueText);
  return Number.isFinite(value) && value >= 0 ? { value } : { error: `${label} deve ser um número igual ou maior que zero.` };
}

async function validateProductionFields(body, user, current = null, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const activityFlag = moduleOrigin === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  const activityLabel = moduleOrigin === 'pecuaria' ? 'pecuária' : 'agrícola';
  const propertyId = Number(body.propertyId ?? current?.Propriedade_idPropriedade);
  const property = Number.isInteger(propertyId) ? (await loadProperty(propertyId)) : null;
  const propertyAvailable = property && (await propertyIsAccessible(user, property)) && (property.Ativo === 1 || current?.Propriedade_idPropriedade === propertyId);
  if (!propertyAvailable) return { error: 'Selecione uma Propriedade ativa disponível para seu perfil.' };

  const activityPropertyId = Number(body.activityPropertyId ?? current?.AtividadePropriedade_idAtividadePropriedade);
  const activityProperty = Number.isInteger(activityPropertyId) ? (await db.prepare(`
    SELECT ap.idAtividadePropriedade, ap.Propriedade_idPropriedade, ap.Atividade_idAtividade,
      a.${activityFlag} AS IsModuleActivity, a.Ativo AS AtividadeAtiva, sp.Ativo AS SafraAtiva
    FROM AtividadePropriedade ap JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    WHERE ap.idAtividadePropriedade = ? AND ap.Propriedade_idPropriedade = ?
  `).get(activityPropertyId, propertyId)) : null;
  if (!activityProperty || activityProperty.IsModuleActivity !== 1 || activityProperty.idAtividadePropriedade !== current?.AtividadePropriedade_idAtividadePropriedade && (activityProperty.AtividadeAtiva !== 1 || activityProperty.SafraAtiva !== 1)) {
    return { error: `Selecione uma atividade ${activityLabel} e safra ativas desta propriedade.` };
  }

  const productId = Number(body.productId ?? current?.Produto_idProduto);
  const product = Number.isInteger(productId) ? (await db.prepare(`
    SELECT p.idProduto, p.Atividade_idAtividade, p.Ativo AS ProdutoAtivo,
      u.idUnidade, u.Ativo AS UnidadeAtiva, a.${activityFlag} AS IsModuleActivity, a.Ativo AS AtividadeAtiva
    FROM Produto p
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    JOIN Atividade a ON a.idAtividade = p.Atividade_idAtividade
    WHERE p.idProduto = ?
  `).get(productId)) : null;
  if (!product || product.Atividade_idAtividade !== activityProperty.Atividade_idAtividade || product.IsModuleActivity !== 1 ||
      (product.ProdutoAtivo !== 1 && productId !== current?.Produto_idProduto) ||
      (product.UnidadeAtiva !== 1 && productId !== current?.Produto_idProduto) ||
      (product.AtividadeAtiva !== 1 && productId !== current?.Produto_idProduto)) {
    return { error: `Selecione um Produto ativo compatível com a Atividade ${activityLabel}.` };
  }

  let talhaoId = current?.TalhaoArea_idTalhaoArea ?? null;
  let plannedArea = current?.AreaPlanejada ?? null;
  if (moduleOrigin === 'agricultura') {
    talhaoId = Number(body.talhaoId ?? current?.TalhaoArea_idTalhaoArea);
    const talhao = Number.isInteger(talhaoId)
      ? (await db.prepare('SELECT Area, Ativo FROM TalhaoArea WHERE idTalhaoArea = ? AND Propriedade_idPropriedade = ?').get(talhaoId, propertyId))
      : null;
    if (!talhao || (!talhao.Ativo && talhaoId !== current?.TalhaoArea_idTalhaoArea)) return { error: 'Selecione um Talhão ativo desta propriedade.' };
    plannedArea = Number(body.areaPlanned ?? current?.AreaPlanejada ?? talhao.Area);
    if (!Number.isFinite(plannedArea) || plannedArea <= 0 || plannedArea > talhao.Area) {
      return { error: `A área planejada deve ser maior que zero e não pode exceder ${talhao.Area}.` };
    }
  }

  const startDate = String(body.startDate || current?.InicioProducao || '').trim();
  if (!isValidIsoDate(startDate)) return { error: 'Informe uma data de início válida.' };
  const situation = String(body.situation || current?.Situacao || 'Planejada');
  if (!['Planejada', 'Realizada'].includes(situation)) return { error: 'Selecione Planejada ou Realizada.' };
  const forecastDate = situation === 'Planejada' ? String(body.forecastDate || '').trim() || null : null;
  if (situation === 'Planejada' && (!forecastDate || !isValidIsoDate(forecastDate))) return { error: 'Informe uma data de previsão válida.' };
  const forecast = optionalQuantity(body.forecast, 'A quantidade prevista');
  if (forecast.error) return { error: forecast.error };
  const realized = optionalQuantity(body.realized, 'A quantidade realizada');
  if (realized.error) return { error: realized.error };
  if (situation === 'Planejada' && forecast.value === null) return { error: 'Informe a quantidade prevista.' };
  if (situation === 'Realizada' && realized.value === null) return { error: 'Informe a quantidade realizada.' };
  const description = String(body.description || '').trim();
  if (description.length > 500) return { error: 'A descrição excede 500 caracteres.' };
  return {
    propertyId, activityPropertyId, productId, unitId: product.idUnidade,
    talhaoId, plannedArea, startDate, forecastDate,
    forecast: situation === 'Planejada' ? forecast.value : null,
    realized: situation === 'Realizada' ? realized.value : null,
    situation, description
  };
}

async function loadProductionForUser(productionId, user, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const production = (await db.prepare(`
    SELECT p.*, ap.Propriedade_idPropriedade,
      prod.Nome AS ProdutoNome, u.Nome AS UnidadeNome, u.Sigla AS UnidadeSigla,
      prop.Nome AS PropriedadeNome, pro.Nome AS ProdutorNome,
      ca.Nome AS AssociacaoNome, a.Descricao AS AtividadeNome, a.Agricultura, a.Pecuaria, sp.Descricao AS SafraNome
    FROM Producao p JOIN Produto prod ON prod.idProduto = p.Produto_idProduto
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pro ON pro.idProdutor = prop.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pro.CooperativaAssociacao_idCooperativaAssociacao
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN SafraPeriodo sp ON sp.idSafraPeriodo = ap.SafraPeriodo_idSafraPeriodo
    WHERE p.IdProducao = ?
  `).get(productionId));
  if (!production) return null;
  const property = (await loadProperty(production.Propriedade_idPropriedade));
  const isModuleActivity = moduleOrigin === 'pecuaria' ? production.Pecuaria === 1 : production.Agricultura === 1;
  return property && (await propertyIsAccessible(user, property)) && isModuleActivity
    ? { ...production, PropertyAtivo: property.Ativo }
    : null;
}

async function renderProductionDeliveries(res, user, production, error = null, status = 200, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const buyers = (await db.prepare('SELECT idComprador, NomeComprador, Ativo FROM Comprador WHERE Ativo = 1 ORDER BY NomeComprador COLLATE NOCASE').all());
  const deliveries = (await db.prepare(`
    SELECT e.idEntrega, e.Comprador_idComprador, e.DataEntrega, e.Quantidade, e.ValorUnitario,
      e.ValorTotal, e.DocumentoEntrega, e.Unidade_idUnidade,
      c.NomeComprador, u.Sigla AS UnidadeSigla
    FROM Entrega e JOIN Comprador c ON c.idComprador = e.Comprador_idComprador
    JOIN Unidade u ON u.idUnidade = e.Unidade_idUnidade
    WHERE e.Producao_idProducao = ? ORDER BY e.DataEntrega DESC, e.idEntrega DESC
  `).all(production.IdProducao));
  const inactiveBuyers = (await db.prepare(`
    SELECT DISTINCT c.idComprador, c.NomeComprador, c.Ativo
    FROM Entrega e JOIN Comprador c ON c.idComprador = e.Comprador_idComprador
    WHERE e.Producao_idProducao = ? AND c.Ativo = 0 ORDER BY c.NomeComprador COLLATE NOCASE
  `).all(production.IdProducao));
  const buyerOptions = [...buyers, ...inactiveBuyers];
  return res.status(status).render('production-deliveries', {
    pageTitle: 'Entregas', production, deliveries, buyerOptions, error, moduleOrigin,
    moduleBasePath: productionModuleBasePath(moduleOrigin)
  });
}

async function renderAgricultureDeliveries(res, user, moduleOrigin = 'agricultura') {
  moduleOrigin = normalizePropertyModule(moduleOrigin);
  const activityFlag = moduleOrigin === 'pecuaria' ? 'Pecuaria' : 'Agricultura';
  const scope = producerScope(user, 'pr');
  const deliveries = (await db.prepare(`
    SELECT e.idEntrega, e.DataEntrega, e.Quantidade, e.ValorUnitario, e.ValorTotal, e.DocumentoEntrega,
      p.IdProducao, p.Situacao, prod.Nome AS ProdutoNome, u.Sigla AS UnidadeSigla,
      c.NomeComprador, prop.Nome AS PropriedadeNome, pr.Nome AS ProdutorNome, ca.Nome AS AssociacaoNome
    FROM Producao p
    JOIN Produto prod ON prod.idProduto = p.Produto_idProduto
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = p.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Unidade u ON u.idUnidade = p.Unidade_idUnidade
    LEFT JOIN Entrega e ON e.Producao_idProducao = p.IdProducao
    LEFT JOIN Comprador c ON c.idComprador = e.Comprador_idComprador
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    JOIN CooperativaAssociacao ca ON ca.idCooperativaAssociacao = pr.CooperativaAssociacao_idCooperativaAssociacao
    WHERE ${scope.sql} AND a.${activityFlag} = 1
    ORDER BY date(e.DataEntrega) DESC, p.IdProducao DESC, e.idEntrega DESC
  `).all(...scope.params));
  return res.render('agriculture-deliveries', {
    pageTitle: 'Entregas', deliveries, moduleOrigin,
    moduleBasePath: productionModuleBasePath(moduleOrigin), activityLabel: moduleOrigin === 'pecuaria' ? 'pecuária' : 'agrícola'
  });
}

app.get(['/agricultura/entregas', '/pecuaria/entregas'], requireAuth, async (req, res) => {
  return (await renderAgricultureDeliveries(res, req.user, productionModuleFromRequest(req)));
});

async function validateDelivery(body, production, current = null) {
  const buyerId = Number(body.buyerId ?? current?.Comprador_idComprador);
  const buyer = Number.isInteger(buyerId) ? (await db.prepare('SELECT Ativo FROM Comprador WHERE idComprador = ?').get(buyerId)) : null;
  if (!buyer || (buyer.Ativo !== 1 && buyerId !== current?.Comprador_idComprador)) return { error: 'Selecione um comprador ativo.' };
  const date = String(body.date || current?.DataEntrega || '').trim();
  if (!isValidIsoDate(date)) return { error: 'Informe uma data de entrega válida.' };
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'A quantidade deve ser maior que zero.' };
  const unitPriceText = String(body.unitPrice ?? '').trim();
  const unitPrice = unitPriceText ? Number(unitPriceText) : null;
  if (unitPriceText && (!Number.isFinite(unitPrice) || unitPrice < 0 || Math.abs(unitPrice * 100 - Math.round(unitPrice * 100)) > 1e-7)) {
    return { error: 'Informe um valor unitário válido, com até duas casas decimais.' };
  }
  const totalText = String(body.totalValue ?? '').trim();
  const totalValue = totalText ? Number(totalText) : unitPrice === null ? null : Number((quantity * unitPrice).toFixed(2));
  if (totalText && (!Number.isFinite(totalValue) || totalValue < 0)) return { error: 'O valor total deve ser maior ou igual a zero.' };
  const document = String(body.document || '').trim();
  if (document.length > 150) return { error: 'O documento excede 150 caracteres.' };
  return { buyerId, date, quantity, unitPrice, totalValue, document, unitId: production.Unidade_idUnidade };
}

app.get(['/agricultura/producoes/:id/entregas', '/pecuaria/producoes/:id/entregas'], requireAuth, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  return (await renderProductionDeliveries(res, req.user, production, null, 200, moduleOrigin));
});

app.post(['/agricultura/producoes/:id/entregas', '/pecuaria/producoes/:id/entregas'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  const fields = (await validateDelivery(req.body, production));
  if (fields.error) return (await renderProductionDeliveries(res, req.user, production, fields.error, 400, moduleOrigin));
  try {
    (await db.prepare(`
      INSERT INTO Entrega (Unidade_idUnidade, Comprador_idComprador, Producao_idProducao, DataEntrega, Quantidade, ValorUnitario, ValorTotal, DocumentoEntrega)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fields.unitId, fields.buyerId, production.IdProducao, fields.date, fields.quantity, fields.unitPrice, fields.totalValue, fields.document || null));
    return res.redirect(`${moduleBasePath}/${production.IdProducao}/entregas`);
  } catch {
    return (await renderProductionDeliveries(res, req.user, production, 'Não foi possível registrar a entrega.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/producoes/:id/entregas/:deliveryId/atualizar', '/pecuaria/producoes/:id/entregas/:deliveryId/atualizar'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  const current = (await db.prepare('SELECT * FROM Entrega WHERE idEntrega = ? AND Producao_idProducao = ?').get(Number(req.params.deliveryId), production.IdProducao));
  if (!current) return (await renderProductionDeliveries(res, req.user, production, 'Entrega não encontrada.', 404, moduleOrigin));
  const fields = (await validateDelivery(req.body, production, current));
  const entregaId = Number(req.params.deliveryId);
  if (fields.error) return (await renderProductionDeliveries(res, req.user, production, fields.error, 400, moduleOrigin));
  try {
    (await db.prepare(`
      UPDATE Entrega SET Comprador_idComprador = ?, DataEntrega = ?, Quantidade = ?,
        ValorUnitario = ?, ValorTotal = ?, DocumentoEntrega = ?
      WHERE idEntrega = ? AND Producao_idProducao = ?
    `).run(fields.buyerId, fields.date, fields.quantity, fields.unitPrice, fields.totalValue, fields.document || null, entregaId, production.IdProducao));
    return res.redirect(`${moduleBasePath}/${production.IdProducao}/entregas`);
  } catch {
    return (await renderProductionDeliveries(res, req.user, production, 'Não foi possível atualizar a entrega.', 400, moduleOrigin));
  }
});

app.post(['/agricultura/producoes/:id/entregas/:deliveryId/excluir', '/pecuaria/producoes/:id/entregas/:deliveryId/excluir'], requireAuth, verifyCsrf, async (req, res) => {
  const moduleOrigin = productionModuleFromRequest(req);
  const moduleBasePath = productionModuleBasePath(moduleOrigin);
  const production = (await loadProductionForUser(Number(req.params.id), req.user, moduleOrigin));
  if (!production) return res.status(404).render('error', { pageTitle: 'Produção não encontrada', message: 'A produção não está disponível para seu perfil.' });
  (await db.prepare('DELETE FROM Entrega WHERE idEntrega = ? AND Producao_idProducao = ?').run(Number(req.params.deliveryId), production.IdProducao));
  return res.redirect(`${moduleBasePath}/${production.IdProducao}/entregas`);
});

app.get('/pecuaria/animais', requireAuth, async (req, res) => (await renderAnimals(res, req.user, req.query)));

app.get('/pecuaria/animais/novo', requireAuth, async (req, res) => {
  const options = (await animalFormOptions(req.user));
  const error = options.activities.length ? null : 'Cadastre uma atividade pecuária ativa em uma propriedade disponível antes de cadastrar animais.';
  return (await renderAnimalForm(res, req.user, null, error, error ? 400 : 200));
});

app.post('/pecuaria/animais', requireAuth, verifyCsrf, async (req, res) => {
  const fields = (await validateAnimalFields(req.body, req.user));
  if (fields.error) return (await renderAnimalForm(res, req.user, null, fields.error, 400, req.body));
  try {
    (await db.prepare(`
      INSERT INTO Animal
        (Categoria_idCategoria, AtividadePropriedade_idAtividadePropriedade, Brinco, Nascimento,
         PrimeiroParto, DataSaida, MotivoSaida_idMotivoSaida, Motivo, Sexo, PertenceRebanho, StatusReprodutivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fields.categoryId, fields.activityId, fields.tag, fields.birthDate, fields.firstCalving,
      fields.exitDate, fields.exitReasonId, fields.exitReason, fields.sex, fields.belongsToHerd, fields.reproductiveStatus));
    return res.redirect('/pecuaria/animais');
  } catch {
    return (await renderAnimalForm(res, req.user, null, 'Não foi possível cadastrar o animal.', 400, req.body));
  }
});

app.get('/pecuaria/animais/:id', requireAuth, async (req, res) => {
  const animal = (await loadAnimalForUser(Number(req.params.id), req.user));
  if (!animal) return res.status(404).render('error', { pageTitle: 'Animal não encontrado', message: 'O animal não está disponível para seu perfil.' });
  return (await renderAnimalForm(res, req.user, animal));
});

app.post('/pecuaria/animais/:id/atualizar', requireAuth, verifyCsrf, async (req, res) => {
  const animal = (await loadAnimalForUser(Number(req.params.id), req.user));
  if (!animal) return res.status(404).render('error', { pageTitle: 'Animal não encontrado', message: 'O animal não está disponível para seu perfil.' });
  const fields = (await validateAnimalFields(req.body, req.user, animal));
  if (fields.error) return (await renderAnimalForm(res, req.user, animal, fields.error, 400, req.body));
  try {
    (await db.prepare(`
      UPDATE Animal SET Categoria_idCategoria = ?, AtividadePropriedade_idAtividadePropriedade = ?,
        Brinco = ?, Nascimento = ?, PrimeiroParto = ?, DataSaida = ?, MotivoSaida_idMotivoSaida = ?,
        Motivo = ?, Sexo = ?, PertenceRebanho = ?, StatusReprodutivo = ?
      WHERE idAnimal = ?
    `).run(fields.categoryId, fields.activityId, fields.tag, fields.birthDate, fields.firstCalving,
      fields.exitDate, fields.exitReasonId, fields.exitReason, fields.sex, fields.belongsToHerd, fields.reproductiveStatus, animal.idAnimal));
    return res.redirect('/pecuaria/animais');
  } catch {
    return (await renderAnimalForm(res, req.user, animal, 'Não foi possível atualizar o animal.', 400, req.body));
  }
});

app.post('/pecuaria/animais/:id/excluir', requireAuth, verifyCsrf, async (req, res) => {
  const animal = (await loadAnimalForUser(Number(req.params.id), req.user));
  if (!animal) return res.status(404).render('error', { pageTitle: 'Animal não encontrado', message: 'O animal não está disponível para seu perfil.' });
  try {
    (await db.prepare('DELETE FROM Animal WHERE idAnimal = ?').run(animal.idAnimal));
    return res.redirect('/pecuaria/animais');
  } catch {
    return (await renderAnimals(res, req.user, req.query, 'O animal possui registros de lactação ou reprodução vinculados e não pode ser excluído.', 400));
  }
});

app.get('/pecuaria/prenhezes', requireAuth, async (req, res) => (await renderPregnancies(res, req.user, 'available')));
app.get('/pecuaria/prenhezes/registro', requireAuth, async (req, res) => (await renderPregnancies(res, req.user, 'records')));
app.get('/pecuaria/lactacoes', requireAuth, async (req, res) => (await renderLactations(res, req.user, req.query)));
app.get('/pecuaria/producao-diaria', requireAuth, async (req, res) => (await renderDailyMilk(res, req.user, req.query)));
app.get('/pecuaria/lactacoes/nova', requireAuth, async (req, res) => (await renderNewLactation(res, req.user)));

app.post('/pecuaria/producao-diaria/lancamentos', requireAuth, verifyCsrf, async (req, res) => {
  const date = String(req.body.date || '').trim();
  const propertyFilter = { date, propertyId: req.body.propertyId };
  const today = new Date().toISOString().slice(0, 10);
  const lactationIds = Array.isArray(req.body.lactationIds) ? req.body.lactationIds : req.body.lactationIds ? [req.body.lactationIds] : [];
  const quantities = Array.isArray(req.body.quantities) ? req.body.quantities : req.body.quantities !== undefined ? [req.body.quantities] : [];
  if (!isValidIsoDate(date) || date > today) {
    return (await renderDailyMilk(res, req.user, propertyFilter, 'Selecione uma data válida, atual ou passada.', 400));
  }
  if (!lactationIds.length || lactationIds.length !== quantities.length) {
    return (await renderDailyMilk(res, req.user, propertyFilter, 'Não foi possível identificar os registros da grade diária.', 400));
  }

  const entries = [];
  for (let index = 0; index < lactationIds.length; index += 1) {
    const lactationId = Number(lactationIds[index]);
    const rawQuantity = String(quantities[index] ?? '').trim();
    if (!Number.isInteger(lactationId) || lactationId < 1) {
      return (await renderDailyMilk(res, req.user, propertyFilter, 'A grade contém uma lactação inválida.', 400));
    }
    if (!rawQuantity) continue;
    const quantity = Number(rawQuantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity < 0) {
      return (await renderDailyMilk(res, req.user, propertyFilter, 'Informe litros válidos, usando um valor igual ou maior que zero.', 400));
    }
    entries.push({ lactationId, quantity });
  }
  if (!entries.length) {
    return (await renderDailyMilk(res, req.user, propertyFilter, 'Informe os litros de pelo menos uma vaca.', 400));
  }
  if (new Set(entries.map((entry) => entry.lactationId)).size !== entries.length) {
    return (await renderDailyMilk(res, req.user, propertyFilter, 'A grade contém lactações repetidas.', 400));
  }

  const scope = producerScope(req.user, 'pr');
  try {
    const saveEntries = db.transaction(async () => {
      const findLactation = db.prepare(`
        SELECT lact.Inicio, lact.Termino FROM Lactacoes lact
        JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
        JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
        JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
        JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
        JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
        WHERE lact.idLactacoes = ? AND animal.Sexo = 'F' AND a.Pecuaria = 1 AND ${scope.sql}
      `);
      const saveEntry = db.prepare(`
        INSERT INTO Lancamentos (Lactacoes_idLactacoes, DataLancamento, Quantidade)
        VALUES (?, ?, ?)
        ON CONFLICT (Lactacoes_idLactacoes, DataLancamento)
        DO UPDATE SET Quantidade = excluded.Quantidade
      `);
      for (const entry of entries) {
        const lactation = (await findLactation.get(entry.lactationId, ...scope.params));
        if (!lactation || date < lactation.Inicio || lactation.Termino && date > lactation.Termino) {
          throw new Error('A data precisa estar dentro do período da lactação selecionada.');
        }
        (await saveEntry.run(entry.lactationId, date, entry.quantity));
      }
    });
    (await saveEntries());
    const propertyQuery = propertyFilter.propertyId ? `&propertyId=${encodeURIComponent(propertyFilter.propertyId)}` : '';
    return res.redirect(`/pecuaria/producao-diaria?date=${encodeURIComponent(date)}${propertyQuery}&saved=1#lancamentos`);
  } catch (error) {
    return (await renderDailyMilk(res, req.user, propertyFilter, error.message || 'Não foi possível salvar os lançamentos.', 400));
  }
});

app.post('/pecuaria/lactacoes/:id/secar', requireAuth, verifyCsrf, async (req, res) => {
  const lactationId = Number(req.params.id);
  const scope = producerScope(req.user, 'pr');
  const findActiveLactation = db.prepare(`
    SELECT lact.idLactacoes, lact.Inicio, animal.idAnimal, prop.idPropriedade,
      (SELECT MAX(milk.DataLancamento) FROM Lancamentos milk WHERE milk.Lactacoes_idLactacoes = lact.idLactacoes) AS UltimoLancamento
    FROM Lactacoes lact
    JOIN Animal animal ON animal.idAnimal = lact.Animal_idAnimal
    JOIN AtividadePropriedade ap ON ap.idAtividadePropriedade = animal.AtividadePropriedade_idAtividadePropriedade
    JOIN Atividade a ON a.idAtividade = ap.Atividade_idAtividade
    JOIN Propriedade prop ON prop.idPropriedade = ap.Propriedade_idPropriedade
    JOIN Produtor pr ON pr.idProdutor = prop.Produtor_idProdutor
    WHERE lact.idLactacoes = ? AND lact.Termino IS NULL AND a.Pecuaria = 1 AND ${scope.sql}
  `);
  const lactation = (await findActiveLactation.get(lactationId, ...scope.params));
  if (!lactation) return res.status(404).render('error', { pageTitle: 'Lactação não encontrada', message: 'A lactação não está disponível para seu perfil.' });

  const endDate = String(req.body.endDate || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(endDate) || endDate < lactation.Inicio || endDate > today || lactation.UltimoLancamento && endDate < lactation.UltimoLancamento) {
    return (await renderLactations(res, req.user, { propertyId: lactation.idPropriedade }, 'Informe uma data de secagem válida, entre o início da lactação, o último lançamento e hoje.', 400));
  }
  try {
    const dryOff = db.transaction(async () => {
      const current = (await findActiveLactation.get(lactationId, ...scope.params));
      if (!current) throw new Error('A lactação já foi encerrada ou não está mais disponível.');
      const result = (await db.prepare('UPDATE Lactacoes SET Termino = ? WHERE idLactacoes = ? AND Termino IS NULL').run(endDate, lactationId));
      if (!result.changes) throw new Error('A lactação já foi encerrada ou não está mais disponível.');
      const hasOtherActive = (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND idLactacoes <> ? AND Termino IS NULL LIMIT 1').get(current.idAnimal, lactationId));
      (await db.prepare('UPDATE Animal SET StatusReprodutivo = ? WHERE idAnimal = ?').run(hasOtherActive ? 'Em Lactação' : 'Vazia', current.idAnimal));
    });
    (await dryOff());
    return res.redirect(`/pecuaria/lactacoes?propertyId=${encodeURIComponent(lactation.idPropriedade)}&dried=1`);
  } catch (error) {
    return (await renderLactations(res, req.user, { propertyId: lactation.idPropriedade }, error.message || 'Não foi possível secar o animal.', 400));
  }
});

app.get('/pecuaria/lactacoes/:id/editar', requireAuth, async (req, res) => {
  const lactation = (await loadLactationForUser(Number(req.params.id), req.user));
  if (!lactation) return res.status(404).render('error', { pageTitle: 'Lactação não encontrada', message: 'A lactação não está disponível para seu perfil.' });
  return renderLactationEdit(res, lactation);
});

app.post('/pecuaria/lactacoes/:id/atualizar', requireAuth, verifyCsrf, async (req, res) => {
  const lactationId = Number(req.params.id);
  const lactation = (await loadLactationForUser(lactationId, req.user));
  if (!lactation) return res.status(404).render('error', { pageTitle: 'Lactação não encontrada', message: 'A lactação não está disponível para seu perfil.' });

  const startDate = String(req.body.startDate || '').trim();
  const endDate = String(req.body.endDate || '').trim() || null;
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(startDate) || startDate > today || (lactation.Nascimento && startDate < lactation.Nascimento)) {
    return renderLactationEdit(res, lactation, 'Informe um início válido, entre o nascimento do animal e hoje.', 400, req.body);
  }
  if (endDate && (!isValidIsoDate(endDate) || endDate < startDate || endDate > today)) {
    return renderLactationEdit(res, lactation, 'Informe um término válido, igual ou posterior ao início e não futuro.', 400, req.body);
  }

  const milkPeriod = (await db.prepare(`
    SELECT MIN(DataLancamento) AS PrimeiroLancamento, MAX(DataLancamento) AS UltimoLancamento
    FROM Lancamentos WHERE Lactacoes_idLactacoes = ?
  `).get(lactationId));
  if (milkPeriod.PrimeiroLancamento && (milkPeriod.PrimeiroLancamento < startDate || endDate && milkPeriod.UltimoLancamento > endDate)) {
    return renderLactationEdit(res, lactation, 'As datas precisam abranger todos os lançamentos de leite já registrados.', 400, req.body);
  }

  try {
    const updateLactation = db.transaction(async () => {
      const current = (await loadLactationForUser(lactationId, req.user));
      if (!current) throw new Error('A lactação não está mais disponível.');
      if (!endDate && (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND idLactacoes <> ? AND Termino IS NULL LIMIT 1').get(current.Animal_idAnimal, lactationId))) {
        throw new Error('O animal já possui outra lactação ativa.');
      }
      const currentMilkPeriod = (await db.prepare(`
        SELECT MIN(DataLancamento) AS PrimeiroLancamento, MAX(DataLancamento) AS UltimoLancamento
        FROM Lancamentos WHERE Lactacoes_idLactacoes = ?
      `).get(lactationId));
      if (currentMilkPeriod.PrimeiroLancamento && (currentMilkPeriod.PrimeiroLancamento < startDate || endDate && currentMilkPeriod.UltimoLancamento > endDate)) {
        throw new Error('As datas precisam abranger todos os lançamentos de leite já registrados.');
      }
      const result = (await db.prepare('UPDATE Lactacoes SET Inicio = ?, Termino = ? WHERE idLactacoes = ?').run(startDate, endDate, lactationId));
      if (!result.changes) throw new Error('Não foi possível atualizar a lactação.');
      const hasOtherActive = (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND idLactacoes <> ? AND Termino IS NULL LIMIT 1').get(current.idAnimal, lactationId));
      (await db.prepare('UPDATE Animal SET StatusReprodutivo = ? WHERE idAnimal = ?').run(endDate && !hasOtherActive ? 'Vazia' : 'Em Lactação', current.idAnimal));
    });
    (await updateLactation());
    return res.redirect(`/pecuaria/lactacoes?propertyId=${encodeURIComponent(lactation.idPropriedade)}&updated=1`);
  } catch (error) {
    const latestLactation = (await loadLactationForUser(lactationId, req.user)) || lactation;
    return renderLactationEdit(res, latestLactation, error.message || 'Não foi possível atualizar a lactação.', 400, req.body);
  }
});

app.post('/pecuaria/lactacoes', requireAuth, verifyCsrf, async (req, res) => {
  const animalId = Number(req.body.animalId);
  const animal = (await loadAnimalForUser(animalId, req.user));
  const availableAnimals = (await lactationAnimals(req.user));
  if (!animal || !availableAnimals.some((item) => item.idAnimal === animalId)) {
    return (await renderNewLactation(res, req.user, 'Selecione uma fêmea no rebanho sem prenhez ou lactação ativa.', 400, req.body));
  }

  const startDate = String(req.body.startDate || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(startDate) || startDate > today || (animal.Nascimento && startDate < animal.Nascimento)) {
    return (await renderNewLactation(res, req.user, 'Informe uma data de início válida, entre o nascimento e hoje.', 400, req.body));
  }

  try {
    const createLactation = db.transaction(async () => {
      const currentAnimal = (await loadAnimalForUser(animalId, req.user));
      if (!currentAnimal || !(await lactationAnimals(req.user)).some((item) => item.idAnimal === animalId)) {
        throw new Error('A fêmea não está mais disponível para iniciar uma lactação.');
      }
      const result = (await db.prepare('INSERT INTO Lactacoes (Animal_idAnimal, Inicio) VALUES (?, ?)').run(animalId, startDate));
      const updated = (await db.prepare("UPDATE Animal SET StatusReprodutivo = 'Em Lactação' WHERE idAnimal = ? AND Sexo = 'F'").run(animalId));
      if (!updated.changes) throw new Error('Não foi possível atualizar a situação reprodutiva da fêmea.');
      return result.lastInsertRowid;
    });
    (await createLactation());
    return res.redirect('/pecuaria/lactacoes');
  } catch (error) {
    return (await renderNewLactation(res, req.user, error.message || 'Não foi possível registrar a lactação.', 400, req.body));
  }
});

app.get('/pecuaria/animais/:id/prenhez/nova', requireAuth, async (req, res) => {
  const animal = (await loadAnimalForUser(Number(req.params.id), req.user));
  if (!animal || animal.Sexo !== 'F' || !animal.PertenceRebanho) {
    return res.status(404).render('error', { pageTitle: 'Animal indisponível', message: 'Selecione uma fêmea que pertença ao rebanho.' });
  }
  if (animal.Prenhez_idPrenhez) return res.redirect(`/pecuaria/prenhezes/${animal.Prenhez_idPrenhez}`);
  return (await renderNewPregnancy(res, req.user, animal));
});

app.post('/pecuaria/prenhezes', requireAuth, verifyCsrf, async (req, res) => {
  const animal = (await loadAnimalForUser(Number(req.body.animalId), req.user));
  if (!animal || animal.Sexo !== 'F' || !animal.PertenceRebanho) {
    return res.status(404).render('error', { pageTitle: 'Animal indisponível', message: 'Selecione uma fêmea que pertença ao rebanho.' });
  }
  if (animal.Prenhez_idPrenhez) return res.redirect(`/pecuaria/prenhezes/${animal.Prenhez_idPrenhez}`);

  const fatherId = req.body.fatherId ? Number(req.body.fatherId) : null;
  const sires = (await pregnancySires(req.user, animal.Propriedade_idPropriedade));
  if (fatherId !== null && !sires.some((sire) => sire.idAnimal === fatherId)) {
    return (await renderNewPregnancy(res, req.user, animal, 'Selecione um pai ativo da mesma propriedade.', 400, req.body));
  }
  const methodId = Number(req.body.pregnancyTypeId);
  const method = (await db.prepare('SELECT idTipoPrenhez FROM TipoPrenhez WHERE idTipoPrenhez = ? AND Ativo = 1').get(methodId));
  if (!method) return (await renderNewPregnancy(res, req.user, animal, 'Selecione um tipo de prenhez ativo.', 400, req.body));
  const pregnancyDate = String(req.body.pregnancyDate || '').trim() || null;
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(pregnancyDate) || pregnancyDate > today) {
    return (await renderNewPregnancy(res, req.user, animal, 'Informe uma data de prenhez válida, atual ou retroativa.', 400, req.body));
  }
  try {
    const createPregnancy = db.transaction(async () => {
      const currentMother = (await db.prepare('SELECT Sexo, Prenhez_idPrenhez FROM Animal WHERE idAnimal = ?').get(animal.idAnimal));
      if (!currentMother || currentMother.Sexo !== 'F' || currentMother.Prenhez_idPrenhez) {
        throw new Error('A mãe já possui uma prenhez ativa ou não está disponível.');
      }
      const result = (await db.prepare(`
        INSERT INTO Prenhez (Animal_idAnimalPai, Animal_idAnimalMae, TipoPrenhez_idTipoPrenhez, DataPrenhez, Status)
        VALUES (?, ?, ?, ?, 'Prenhez Pendente')
      `).run(fatherId, animal.idAnimal, methodId, pregnancyDate));
      (await db.prepare(`UPDATE Animal SET Prenhez_idPrenhez = ?, StatusReprodutivo = 'Prenhez Pendente' WHERE idAnimal = ?`)
        .run(result.lastInsertRowid, animal.idAnimal));
      return result.lastInsertRowid;
    });
    return res.redirect(`/pecuaria/prenhezes/${(await createPregnancy())}/confirmar`);
  } catch {
    return (await renderNewPregnancy(res, req.user, animal, 'Não foi possível registrar a prenhez.', 400, req.body));
  }
});

app.get('/pecuaria/prenhezes/:id', requireAuth, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  if (pregnancy.Status === 'Prenhez Pendente') return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}/confirmar`);
  if (pregnancy.Status === 'Prenhez Confirmada') return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}/parto`);
  return res.redirect('/pecuaria/prenhezes/registro');
});

app.get('/pecuaria/prenhezes/:id/confirmar', requireAuth, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  if (pregnancy.Status !== 'Prenhez Pendente') return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}`);
  return renderPregnancyConfirmation(res, pregnancy);
});

app.get('/pecuaria/prenhezes/:id/previsao', requireAuth, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  if (!['Prenhez Pendente', 'Prenhez Confirmada'].includes(pregnancy.Status)) return res.redirect('/pecuaria/prenhezes/registro');
  return renderPregnancyConfirmation(res, pregnancy, null, 200, {}, 'forecast');
});

app.post(['/pecuaria/prenhezes/:id/confirmar', '/pecuaria/prenhezes/:id/previsao'], requireAuth, verifyCsrf, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  const forecastEdit = req.path.endsWith('/previsao');
  if (pregnancy.Status !== 'Prenhez Pendente' && !(forecastEdit && pregnancy.Status === 'Prenhez Confirmada')) {
    return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}`);
  }

  const confirmationDate = String(req.body.confirmationDate || '').trim();
  const pregnancyDate = String(req.body.pregnancyDate || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(confirmationDate) || confirmationDate > today) {
    return renderPregnancyConfirmation(res, pregnancy, 'Informe uma data de confirmação válida.', 400, req.body, forecastEdit ? 'forecast' : 'confirm');
  }
  if (!isValidIsoDate(pregnancyDate) || pregnancyDate > today || pregnancyDate > confirmationDate) {
    return renderPregnancyConfirmation(res, pregnancy, 'Informe uma data de prenhez válida, anterior ou igual à confirmação.', 400, req.body, forecastEdit ? 'forecast' : 'confirm');
  }
  const daysRaw = String(req.body.daysPregnant ?? '').trim();
  const daysPregnant = daysRaw ? Number(daysRaw) : null;
  if (daysRaw && (!Number.isInteger(daysPregnant) || daysPregnant < 0 || daysPregnant > pregnancy.DiasGestacao)) {
    return renderPregnancyConfirmation(res, pregnancy, `Os dias de prenhez devem estar entre 0 e ${pregnancy.DiasGestacao}.`, 400, req.body, forecastEdit ? 'forecast' : 'confirm');
  }
  const expectedCalvingDate = daysPregnant === null
    ? addDaysToIsoDate(pregnancyDate, pregnancy.DiasGestacao)
    : addDaysToIsoDate(confirmationDate, pregnancy.DiasGestacao - daysPregnant);
  if (!isValidIsoDate(expectedCalvingDate) || expectedCalvingDate <= today) {
    return renderPregnancyConfirmation(res, pregnancy, 'A previsão do parto deve ser uma data futura.', 400, req.body, forecastEdit ? 'forecast' : 'confirm');
  }
  try {
    const confirmPregnancy = db.transaction(async () => {
      const update = (await db.prepare(`
        UPDATE Prenhez SET DataPrenhez = ?, DataConfirmacao = ?, DataParto = ?, DiasPrenhe = ?, Status = 'Prenhez Confirmada'
        WHERE idPrenhez = ? AND Status = ?
      `).run(pregnancyDate, confirmationDate, expectedCalvingDate, daysPregnant, pregnancy.idPrenhez, pregnancy.Status));
      if (!update.changes) throw new Error('A prenhez foi alterada em outra sessão.');
      if (pregnancy.Status === 'Prenhez Pendente') {
        const motherUpdate = (await db.prepare(`
          UPDATE Animal SET StatusReprodutivo = 'Prenhez Confirmada'
          WHERE idAnimal = ? AND Prenhez_idPrenhez = ?
        `).run(pregnancy.Animal_idAnimalMae, pregnancy.idPrenhez));
        if (!motherUpdate.changes) throw new Error('O vínculo da mãe com a prenhez foi alterado.');
      }
    });
    (await confirmPregnancy());
    return res.redirect('/pecuaria/prenhezes/registro');
  } catch {
    return renderPregnancyConfirmation(res, pregnancy, 'Não foi possível confirmar a prenhez.', 400, req.body, forecastEdit ? 'forecast' : 'confirm');
  }
});

app.get('/pecuaria/prenhezes/:id/parto', requireAuth, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  if (pregnancy.Status !== 'Prenhez Confirmada') return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}`);
  return (await renderCalvingForm(res, pregnancy));
});

app.post('/pecuaria/prenhezes/:id/parto', requireAuth, verifyCsrf, async (req, res) => {
  const pregnancy = (await loadPregnancyForUser(Number(req.params.id), req.user));
  if (!pregnancy) return res.status(404).render('error', { pageTitle: 'Prenhez não encontrada', message: 'O registro não está disponível para seu perfil.' });
  if (pregnancy.Status !== 'Prenhez Confirmada') return res.redirect(`/pecuaria/prenhezes/${pregnancy.idPrenhez}`);

  const birthDate = String(req.body.birthDate || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(birthDate) || birthDate > today) {
    return (await renderCalvingForm(res, pregnancy, 'Informe uma data de parto válida, não futura.', 400, req.body));
  }
  const birthTypeId = Number(req.body.birthTypeId);
  const birthType = (await db.prepare('SELECT idTipoParto, Nome, Quantidade FROM TipoParto WHERE idTipoParto = ? AND Ativo = 1').get(birthTypeId));
  if (!birthType || !Number.isInteger(birthType.Quantidade) || birthType.Quantidade < 1 || birthType.Quantidade > 20) {
    return (await renderCalvingForm(res, pregnancy, 'Selecione um tipo de parto ativo com quantidade válida de nascidos.', 400, req.body));
  }
  const asArray = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
  const sexes = asArray(req.body.offspringSexes).map((value) => String(value || ''));
  const submittedTags = asArray(req.body.offspringTags).map((value) => String(value || '').trim());
  if (sexes.length !== birthType.Quantidade || sexes.some((sex) => !['F', 'M'].includes(sex))) {
    return (await renderCalvingForm(res, pregnancy, `Informe o sexo de cada um dos ${birthType.Quantidade} animais previstos para este parto.`, 400, req.body));
  }

  const categoryBySex = new Map();
  for (const sex of new Set(sexes)) {
    const category = (await db.prepare(`
      SELECT idCategoria FROM Categoria WHERE Sexo = ? AND Ativo = 1 ORDER BY IdadeMinima, idCategoria LIMIT 1
    `).get(sex));
    if (!category) return (await renderCalvingForm(res, pregnancy, `Cadastre uma categoria inicial ativa para ${sex === 'F' ? 'fêmeas' : 'machos'}.`, 400, req.body));
    categoryBySex.set(sex, category.idCategoria);
  }
  const cowCategory = (await db.prepare(`SELECT idCategoria FROM Categoria WHERE lower(Nome) = 'vaca' AND Sexo = 'F' AND Ativo = 1 LIMIT 1`).get());
  if (!cowCategory) return (await renderCalvingForm(res, pregnancy, 'Cadastre a categoria ativa Vaca para atualizar a mãe após o parto.', 400, req.body));

  const tags = sexes.map((_, index) => submittedTags[index] || `NASC-${pregnancy.idPrenhez}-${index + 1}`);
  const normalizedTags = tags.map((tag) => tag.toLocaleLowerCase('pt-BR'));
  if (tags.some((tag) => tag.length > 80) || new Set(normalizedTags).size !== tags.length) {
    return (await renderCalvingForm(res, pregnancy, 'Informe brincos válidos e diferentes para os animais nascidos.', 400, req.body));
  }
  const duplicateTag = db.prepare(`
    SELECT 1 FROM Animal other JOIN AtividadePropriedade ap
      ON ap.idAtividadePropriedade = other.AtividadePropriedade_idAtividadePropriedade
    WHERE ap.Propriedade_idPropriedade = ? AND other.Brinco = ? COLLATE NOCASE LIMIT 1
  `);
  let duplicatedTag = false;
  for (const tag of tags) {
    if ((await duplicateTag.get(pregnancy.idPropriedade, tag))) {
      duplicatedTag = true;
      break;
    }
  }
  if (duplicatedTag) {
    return (await renderCalvingForm(res, pregnancy, 'Um dos brincos informados já existe nesta propriedade. Ajuste os brincos ou deixe-os vazios para gerar identificações provisórias.', 400, req.body));
  }

  const enterLactation = req.body.enterLactation === '1';
  if (enterLactation && (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND Termino IS NULL LIMIT 1').get(pregnancy.Animal_idAnimalMae))) {
    return (await renderCalvingForm(res, pregnancy, 'A mãe já possui uma lactação ativa. Encerre-a antes de iniciar outra.', 400, req.body));
  }
  const stillborn = /natimorto/i.test(birthType.Nome);
  const deathReason = stillborn ? (await db.prepare("SELECT idMotivoSaida FROM MotivoSaida WHERE Ativo = 1 AND lower(Descricao) = 'morte' LIMIT 1").get())?.idMotivoSaida || null : null;
  try {
    const registerCalving = db.transaction(async () => {
      const currentPregnancy = (await db.prepare('SELECT Status, Animal_idAnimalMae FROM Prenhez WHERE idPrenhez = ?').get(pregnancy.idPrenhez));
      const currentMother = (await db.prepare('SELECT Sexo, Prenhez_idPrenhez FROM Animal WHERE idAnimal = ?').get(pregnancy.Animal_idAnimalMae));
      if (!currentPregnancy || currentPregnancy.Status !== 'Prenhez Confirmada' || !currentMother || currentMother.Sexo !== 'F' || currentMother.Prenhez_idPrenhez !== pregnancy.idPrenhez) {
        throw new Error('A prenhez ou o vínculo da mãe foi alterado.');
      }
      if (enterLactation && (await db.prepare('SELECT 1 FROM Lactacoes WHERE Animal_idAnimal = ? AND Termino IS NULL LIMIT 1').get(pregnancy.Animal_idAnimalMae))) {
        throw new Error('A mãe já possui uma lactação ativa.');
      }
      const insertAnimal = db.prepare(`
        INSERT INTO Animal
          (Categoria_idCategoria, AtividadePropriedade_idAtividadePropriedade, Brinco, Nascimento,
           Sexo, PertenceRebanho, DataSaida, MotivoSaida_idMotivoSaida, Prenhez_idPrenhez,
           Animal_idAnimalPai, Animal_idAnimalMae, StatusReprodutivo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `);
      for (let index = 0; index < sexes.length; index += 1) {
        const sex = sexes[index];
        const belongsToHerd = stillborn ? 0 : 1;
        (await insertAnimal.run(categoryBySex.get(sex), pregnancy.AtividadePropriedade_idAtividadePropriedade,
          tags[index], birthDate, sex, belongsToHerd, stillborn ? birthDate : null, deathReason,
          pregnancy.Animal_idAnimalPai, pregnancy.Animal_idAnimalMae,
          sex === 'M' ? 'Não aplicável' : 'Vazia'));
      }
      const motherUpdate = (await db.prepare(`
        UPDATE Animal SET Categoria_idCategoria = ?, PrimeiroParto = COALESCE(PrimeiroParto, ?),
          Prenhez_idPrenhez = NULL, StatusReprodutivo = ? WHERE idAnimal = ?
      `).run(cowCategory.idCategoria, birthDate, enterLactation ? 'Em Lactação' : 'Vazia', pregnancy.Animal_idAnimalMae));
      if (!motherUpdate.changes) throw new Error('Não foi possível atualizar a mãe.');
      if (enterLactation) {
        (await db.prepare('INSERT INTO Lactacoes (Animal_idAnimal, Inicio) VALUES (?, ?)')
          .run(pregnancy.Animal_idAnimalMae, birthDate));
      }
      const pregnancyUpdate = (await db.prepare(`
        UPDATE Prenhez SET TipoParto_idTipoParto = ?, DataParto = ?, Status = 'Parto Realizado'
        WHERE idPrenhez = ? AND Status = 'Prenhez Confirmada'
      `).run(birthTypeId, birthDate, pregnancy.idPrenhez));
      if (!pregnancyUpdate.changes) throw new Error('A prenhez já foi encerrada.');
    });
    (await registerCalving());
    return res.redirect('/pecuaria/prenhezes/registro');
  } catch {
    return (await renderCalvingForm(res, pregnancy, 'Não foi possível registrar o parto e seus vínculos. Nenhuma alteração foi mantida.', 400, req.body));
  }
});

app.get('/modulos', requireAuth, (req, res) => {
  const availableModules = Object.entries(moduleInfo)
    .filter(([, module]) => module.roles.includes(req.user.Perfil))
    .map(([slug, module]) => ({ slug, ...module }));
  res.render('modules', { pageTitle: 'Módulos', modules: availableModules });
});

app.get('/modulos/:slug', requireAuth, async (req, res) => {
  const module = moduleInfo[req.params.slug];
  if (!module) return res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'O módulo solicitado não existe.' });
  if (!module.roles.includes(req.user.Perfil)) {
    return res.status(403).render('error', { pageTitle: 'Acesso restrito', message: 'Seu perfil não tem acesso a este módulo.' });
  }
  if (req.params.slug === 'admin') {
    return res.redirect(req.user.Perfil === 'Administrador' ? '/admin/usuarios' : '/admin/produtores');
  }
  const forecastChart = req.params.slug === 'agricultura'
    ? (await getProductionForecastChart(req.user, req.query.productId))
    : null;
  const milkChart = req.params.slug === 'pecuaria'
    ? (await getMilkProductionChart(req.user, req.query.propertyId, req.query.animalId))
    : null;
  res.render('module', { pageTitle: module.title, module, metrics: (await getModuleMetrics(req.user, req.params.slug)), forecastChart, milkChart });
});

app.use((req, res) => res.status(404).render('error', { pageTitle: 'Página não encontrada', message: 'O endereço solicitado não existe.' }));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).render('error', { pageTitle: 'Erro', message: 'Não foi possível concluir a operação.' });
});

module.exports = app;

if (!process.env.VERCEL) {
  db.ready.then(() => {
    app.listen(port, process.env.HOST || '127.0.0.1', () => {
      console.log(`Vértice Agro disponível em http://${process.env.HOST || '127.0.0.1'}:${port}`);
    });
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}