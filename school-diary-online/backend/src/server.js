require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, '../../frontend')));
app.get('/', (req,res)=>res.sendFile(require('path').join(__dirname, '../../frontend/index.html')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function auth(req,res,next){
  try {
    const token=(req.headers.authorization||'').replace('Bearer ','');
    if(!token) return res.status(401).json({error:'Требуется вход'});
    req.user=jwt.verify(token,process.env.JWT_SECRET);
    next();
  } catch(e){ return res.status(401).json({error:'Недействительный токен'}); }
}
function role(...roles){
  return (req,res,next)=>roles.includes(req.user.role)
    ? next() : res.status(403).json({error:'Недостаточно прав'});
}
function sign(user){
  return jwt.sign({id:user.id,schoolId:user.school_id,role:user.role},process.env.JWT_SECRET,{expiresIn:'7d'});
}

app.get('/api/health',(req,res)=>res.json({ok:true}));

app.post('/api/auth/login', async(req,res)=>{
  try{
    const {email,password}=req.body;
    const r=await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1',[email]);
    if(!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash)))
      return res.status(401).json({error:'Неверный логин или пароль'});
    const u=r.rows[0];
    res.json({token:sign(u),user:{id:u.id,name:u.full_name,email:u.email,role:u.role}});
  }catch(e){res.status(500).json({error:'Ошибка сервера'});}
});

app.get('/api/me',auth,async(req,res)=>{
  const r=await pool.query('SELECT id,full_name,email,role FROM users WHERE id=$1',[req.user.id]);
  res.json(r.rows[0]);
});

app.get('/api/classes',auth,async(req,res)=>{
  const r=await pool.query('SELECT * FROM classes WHERE school_id=$1 ORDER BY name',[req.user.schoolId]);
  res.json(r.rows);
});

app.post('/api/classes',auth,role('director'),async(req,res)=>{
  const {name,academicYear='2026/2027'}=req.body;
  const r=await pool.query(
    'INSERT INTO classes(school_id,name,academic_year) VALUES($1,$2,$3) RETURNING *',
    [req.user.schoolId,name,academicYear]
  );
  res.status(201).json(r.rows[0]);
});

app.get('/api/students',auth,async(req,res)=>{
  const r=await pool.query(`
    SELECT s.id,u.full_name,u.email,c.name class_name,c.id class_id
    FROM students s JOIN users u ON u.id=s.user_id
    JOIN classes c ON c.id=s.class_id
    WHERE u.school_id=$1 ORDER BY u.full_name`,[req.user.schoolId]);
  res.json(r.rows);
});

app.post('/api/students',auth,role('director'),async(req,res)=>{
  const {name,email,password,classId}=req.body;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const hash=await bcrypt.hash(password,10);
    const u=await client.query(
      `INSERT INTO users(school_id,full_name,email,password_hash,role)
       VALUES($1,$2,$3,$4,'student') RETURNING id,full_name,email,role`,
      [req.user.schoolId,name,email,hash]);
    const s=await client.query(
      'INSERT INTO students(user_id,class_id) VALUES($1,$2) RETURNING *',
      [u.rows[0].id,classId]);
    await client.query('COMMIT');
    res.status(201).json({...u.rows[0],studentId:s.rows[0].id});
  }catch(e){
    await client.query('ROLLBACK'); res.status(400).json({error:e.message});
  }finally{client.release();}
});

app.get('/api/teachers',auth,role('director'),async(req,res)=>{
  const r=await pool.query(`
    SELECT t.id,u.full_name,u.email
    FROM teachers t JOIN users u ON u.id=t.user_id
    WHERE u.school_id=$1 ORDER BY u.full_name`,[req.user.schoolId]);
  res.json(r.rows);
});

app.post('/api/teachers',auth,role('director'),async(req,res)=>{
  const {name,email,password}=req.body;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const hash=await bcrypt.hash(password,10);
    const u=await client.query(
      `INSERT INTO users(school_id,full_name,email,password_hash,role)
       VALUES($1,$2,$3,$4,'teacher') RETURNING id,full_name,email,role`,
      [req.user.schoolId,name,email,hash]);
    const t=await client.query('INSERT INTO teachers(user_id) VALUES($1) RETURNING *',[u.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({...u.rows[0],teacherId:t.rows[0].id});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}
  finally{client.release();}
});

app.get('/api/subjects',auth,async(req,res)=>{
  const r=await pool.query('SELECT * FROM subjects WHERE school_id=$1 ORDER BY name',[req.user.schoolId]);
  res.json(r.rows);
});

app.post('/api/subjects',auth,role('director'),async(req,res)=>{
  const r=await pool.query(
    'INSERT INTO subjects(school_id,name) VALUES($1,$2) RETURNING *',
    [req.user.schoolId,req.body.name]);
  res.status(201).json(r.rows[0]);
});

app.post('/api/assignments',auth,role('director'),async(req,res)=>{
  const {teacherId,subjectId,classId}=req.body;
  const r=await pool.query(
    `INSERT INTO teacher_assignments(teacher_id,subject_id,class_id)
     VALUES($1,$2,$3) RETURNING *`,[teacherId,subjectId,classId]);
  res.status(201).json(r.rows[0]);
});

app.get('/api/teacher/classes',auth,role('teacher'),async(req,res)=>{
  const r=await pool.query(`
    SELECT DISTINCT c.id,c.name,s.name subject_name,s.id subject_id
    FROM teacher_assignments a
    JOIN teachers t ON t.id=a.teacher_id
    JOIN classes c ON c.id=a.class_id
    JOIN subjects s ON s.id=a.subject_id
    WHERE t.user_id=$1 ORDER BY c.name`,[req.user.id]);
  res.json(r.rows);
});

app.get('/api/teacher/students/:classId',auth,role('teacher'),async(req,res)=>{
  const r=await pool.query(`
    SELECT st.id,u.full_name
    FROM students st JOIN users u ON u.id=st.user_id
    JOIN teacher_assignments a ON a.class_id=st.class_id
    JOIN teachers t ON t.id=a.teacher_id
    WHERE t.user_id=$1 AND st.class_id=$2
    GROUP BY st.id,u.full_name ORDER BY u.full_name`,
    [req.user.id,req.params.classId]);
  res.json(r.rows);
});

app.post('/api/grades',auth,role('teacher'),async(req,res)=>{
  const {studentId,subjectId,classId,grade,comment}=req.body;
  const teacher=await pool.query('SELECT id FROM teachers WHERE user_id=$1',[req.user.id]);
  if(!teacher.rows[0]) return res.status(403).json({error:'Профиль учителя не найден'});
  const allowed=await pool.query(`
    SELECT 1 FROM teacher_assignments
    WHERE teacher_id=$1 AND subject_id=$2 AND class_id=$3
  `,[teacher.rows[0].id,subjectId,classId]);
  if(!allowed.rows[0]) return res.status(403).json({error:'Вы не преподаёте этот предмет в этом классе'});
  const student=await pool.query('SELECT 1 FROM students WHERE id=$1 AND class_id=$2',[studentId,classId]);
  if(!student.rows[0]) return res.status(400).json({error:'Ученик не относится к этому классу'});
  const r=await pool.query(`
    INSERT INTO grades(student_id,teacher_id,subject_id,class_id,grade,comment)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [studentId,teacher.rows[0].id,subjectId,classId,grade,comment||null]);
  res.status(201).json(r.rows[0]);
});

app.get('/api/student/grades',auth,role('student'),async(req,res)=>{
  const r=await pool.query(`
    SELECT g.id,g.grade,g.comment,g.grade_date,s.name subject_name
    FROM grades g JOIN subjects s ON s.id=g.subject_id
    JOIN students st ON st.id=g.student_id
    WHERE st.user_id=$1 ORDER BY g.grade_date DESC,g.created_at DESC`,
    [req.user.id]);
  res.json(r.rows);
});

app.get('/api/student/statistics',auth,role('student'),async(req,res)=>{
  const r=await pool.query(`
    SELECT COALESCE(ROUND(AVG(g.grade)::numeric,2),0) average,COUNT(*) total
    FROM grades g JOIN students s ON s.id=g.student_id
    WHERE s.user_id=$1`,[req.user.id]);
  res.json(r.rows[0]);
});

app.get('/api/director/statistics',auth,role('director'),async(req,res)=>{
  const q=async(sql)=> (await pool.query(sql,[req.user.schoolId])).rows[0].count;
  res.json({
    students:await q('SELECT COUNT(*) FROM students s JOIN users u ON u.id=s.user_id WHERE u.school_id=$1'),
    teachers:await q('SELECT COUNT(*) FROM teachers t JOIN users u ON u.id=t.user_id WHERE u.school_id=$1'),
    classes:await q('SELECT COUNT(*) FROM classes WHERE school_id=$1'),
    subjects:await q('SELECT COUNT(*) FROM subjects WHERE school_id=$1')
  });
});

const port=process.env.PORT||5000;
app.listen(port,()=>console.log(`School Diary API: http://localhost:${port}`));
