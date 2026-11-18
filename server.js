const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const mysql = require('mysql2');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Carpeta pública para servir archivos estáticos (imágenes subidas)
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de Multer para guardar las fotos locales de forma opcional
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'entrenamiento-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// CONFIGURACIÓN HÍBRIDA (MySQL local / PostgreSQL para Render)
let db;

if (process.env.DATABASE_URL) {
  // Configuración para la nube (PostgreSQL en Render)
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('☁️ Conectado al pool de PostgreSQL para la nube (Render)');
  
  // Función automática para crear la tabla en PostgreSQL si no existe
  async function asegurarTablaPostgres() {
    try {
      const sqlCrear = `
        CREATE TABLE IF NOT EXISTS entrenamientos (
          id SERIAL PRIMARY KEY,
          titulo VARCHAR(255) NOT NULL,
          disciplina VARCHAR(100) NOT NULL,
          fecha DATE NOT NULL,
          mes VARCHAR(50) NOT NULL,
          duracion VARCHAR(150) NOT NULL,
          imagen_url VARCHAR(500) DEFAULT NULL,
          notas TEXT
        );
      `;
      await db.query(sqlCrear);
      console.log('🟢 Tabla "entrenamientos" verificada o creada automáticamente en PostgreSQL.');
    } catch (err) {
      console.error('🔴 Error al crear la tabla automáticamente en PostgreSQL:', err);
    }
  }
  asegurarTablaPostgres();

} else {
  // Configuración para tu máquina LOCAL (MySQL)
  db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Mayoral',
    database: 'bitacora_pro'
  });
  db.connect((err) => {
    if (err) {
      console.error('❌ Error conectando a MySQL:', err);
      return;
    }
    console.log('🔥 Conectado a la base de datos local bitacora_pro con éxito');
  });
}

// Función auxiliar unificada para consultas (compatible con MySQL local y Postgres en la nube)
function queryDB(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (process.env.DATABASE_URL) {
      // Sintaxis para PostgreSQL (convierte los '?' en '$1, $2', etc.)
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      db.query(pgSql, params, (err, res) => {
        if (err) reject(err);
        else resolve(res.rows);
      });
    } else {
      // Sintaxis para MySQL local
      db.query(sql, params, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    }
  });
}

// Ruta Principal con Filtros y Paginación de 4 en 4
app.get('/', async (req, res) => {
  try {
    const disciplina = req.query.disciplina || 'Todas';
    const mes = req.query.mes || '';
    const currentPage = parseInt(req.query.page, 10) || 1;
    const limit = 4;
    const offset = (currentPage - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (disciplina !== 'Todas') {
      whereClauses.push(`disciplina = ${process.env.DATABASE_URL ? '$' + (params.length + 1) : '?'}`);
      params.push(disciplina);
    }
    if (mes.trim() !== '') {
      whereClauses.push(`mes LIKE ${process.env.DATABASE_URL ? '$' + (params.length + 1) : '?'}`);
      params.push(`%${mes.trim()}%`);
    }

    const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countResult = await queryDB(`SELECT COUNT(*) AS total FROM entrenamientos ${whereSQL}`, params);
    const totalRecords = parseInt(countResult[0].total, 10);
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    // Ajuste dinámico de LIMIT y OFFSET para la sintaxis de Postgres ($N) vs MySQL (?)
    let queryEntrenamientos;
    let queryParams;

    if (process.env.DATABASE_URL) {
      const p1 = params.length + 1;
      const p2 = params.length + 2;
      queryEntrenamientos = `SELECT * FROM entrenamientos ${whereSQL} ORDER BY fecha DESC, id DESC LIMIT $${p1} OFFSET $${p2}`;
      queryParams = [...params, limit, offset];
    } else {
      queryEntrenamientos = `SELECT * FROM entrenamientos ${whereSQL} ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?`;
      queryParams = [...params, limit, offset];
    }

    const entrenamientos = await queryDB(queryEntrenamientos, queryParams);

    res.render('index', {
      entrenamientos: entrenamientos || [],
      currentPage,
      totalPages,
      totalRecords,
      filtros: { disciplina, mes },
      mensajeContacto: req.query.contacto === 'ok'
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al obtener entrenamientos');
  }
});

// Agregar entrenamiento (imagen opcional)
app.post('/agregar', upload.single('imagen_archivo'), async (req, res) => {
  try {
    const { titulo, disciplina, fecha, duracion, notas } = req.body;
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const partesFecha = (fecha || '').split('-');
    const mesTexto = partesFecha.length === 3 ? `${meses[parseInt(partesFecha[1], 10) - 1]} ${partesFecha[0]}` : 'General';
    
    const imagenUrl = req.file ? `/uploads/${req.file.filename}` : null;

    await queryDB(
      'INSERT INTO entrenamientos (titulo, disciplina, fecha, mes, duracion, imagen_url, notas) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        titulo || 'Entrenamiento',
        disciplina || 'Running',
        fecha || new Date().toISOString().split('T')[0],
        mesTexto,
        duracion || 'General',
        imagenUrl,
        notas || ''
      ]
    );
    res.redirect('/');
  } catch (err) {
    console.error('❌ ERROR EN BASE DE DATOS:', err);
    res.status(500).send('Error al guardar en la base de datos');
  }
});

// Editar entrenamiento (imagen opcional)
app.post('/editar/:id', upload.single('imagen_archivo'), async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, disciplina, fecha, duracion, notas } = req.body;
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const partesFecha = (fecha || '').split('-');
    const mesTexto = partesFecha.length === 3 ? `${meses[parseInt(partesFecha[1], 10) - 1]} ${partesFecha[0]}` : 'General';

    if (req.file) {
      const imagenUrl = `/uploads/${req.file.filename}`;
      await queryDB(
        'UPDATE entrenamientos SET titulo = ?, disciplina = ?, fecha = ?, mes = ?, duracion = ?, imagen_url = ?, notas = ? WHERE id = ?',
        [titulo, disciplina, fecha, mesTexto, duracion, imagenUrl, notas, id]
      );
    } else {
      await queryDB(
        'UPDATE entrenamientos SET titulo = ?, disciplina = ?, fecha = ?, mes = ?, duracion = ?, notas = ? WHERE id = ?',
        [titulo, disciplina, fecha, mesTexto, duracion, notas, id]
      );
    }
    res.redirect('/');
  } catch (err) {
    console.error('Error al actualizar:', err);
    res.status(500).send('Error al actualizar');
  }
});

// Eliminar entrenamiento
app.post('/eliminar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const results = await queryDB('SELECT imagen_url FROM entrenamientos WHERE id = ?', [id]);
    
    if (results.length > 0 && results[0].imagen_url && results[0].imagen_url.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, 'public', results[0].imagen_url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    await queryDB('DELETE FROM entrenamientos WHERE id = ?', [id]);
    res.redirect('/');
  } catch (err) {
    console.error('Error al eliminar:', err);
    res.status(500).send('Error al eliminar');
  }
});

// Buzón de metas
app.post('/contacto', (req, res) => {
  const { nombre, correo, mensaje } = req.body;
  console.log(`📩 Mensaje recibido de ${nombre} (${correo}): ${mensaje}`);
  res.redirect('/?contacto=ok#footer-form');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor deportivo activo en http://localhost:${PORT}`);
});