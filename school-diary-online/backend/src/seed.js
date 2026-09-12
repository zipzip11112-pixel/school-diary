require('dotenv').config();
const bcrypt=require('bcrypt');
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL});

(async()=>{
  try{
    let r=await pool.query('SELECT id FROM schools LIMIT 1');
    let schoolId=r.rows[0]?.id;
    if(!schoolId){
      r=await pool.query("INSERT INTO schools(name) VALUES('Школа №1') RETURNING id");
      schoolId=r.rows[0].id;
    }
    const hash=await bcrypt.hash('123456',10);
    await pool.query(`
      INSERT INTO users(school_id,full_name,email,password_hash,role)
      VALUES($1,'Директор школы','director@school.tj',$2,'director')
      ON CONFLICT(school_id,email) DO NOTHING
    `,[schoolId,hash]);
    console.log('Готово.');
    console.log('Логин: director@school.tj');
    console.log('Пароль: 123456');
  }catch(e){console.error(e);}
  finally{await pool.end();}
})();
