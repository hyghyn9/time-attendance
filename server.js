// ระบบบันทึกเวลาเข้า-ออก LINE LIFF + Auto GPS Detection + SQLite
// ไฟล์: server.js (แก้ไขสมบูรณ์)

const express = require('express');
const line = require('@line/bot-sdk');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const XLSX = require('xlsx');

const app = express();

// การตั้งค่า LINE Bot
const config = {
  channelAccessToken: '4swA0jo5g7GX6DNZrj4XMDE8GKi002gndjUFXZaxmcbFsVmoK4UyFka+9gygUik3fHxK95Vn3p7DGDhO5VNWqDLhI+8is/lchKx32Z9yK5q0qBtB7fQbLVb9YCHOUIT0NZNsGqVI6bIbrQXHfImdsQdB04t89/1O/w1cDnyilFU=',
  channelSecret: '00cd82a6286896e760fc1c59433f2f83' // จาก Messaging API > Channel Secret
};

const client = new line.Client(config);

// การตั้งค่าฐานข้อมูล SQLite
const DB_PATH = './attendance.db';

// พิกัดสำนักงาน (บ้านที่นครราชสีมา)
const OFFICE_LOCATION = { //14.995920, 102.107690  //ios 14.995906, 102.107861
  latitude: 14.995920,   // ละติจูดบ้านที่ถูกต้อง
  longitude: 102.107690,  // ลองจิจูดบ้านที่ถูกต้อง
  radius: 10                     // รัศมีที่อนุญาต (เมตร)
};

// URL สำหรับ ngrok (อัปเดตเมื่อ restart ngrok)
const BASE_URL = process.env.BASE_URL || 'https://abc123.ngrok.io';

// เริ่มต้นฐานข้อมูล SQLite ด้วย sqlite3
let db;

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    // สร้างหรือเชื่อมต่อฐานข้อมูล
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error connecting to database:', err);
        reject(err);
        return;
      }
      console.log('Connected to SQLite database:', DB_PATH);
      
      // สร้างตารางแบบ serialize
      db.serialize(() => {
        // สร้างตาราง attendance
        db.run(`
          CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            checkin_time TEXT,
            checkout_time TEXT,
            checkin_lat REAL,
            checkin_lon REAL,
            checkout_lat REAL,
            checkout_lon REAL,
            created_at TEXT NOT NULL,
            note TEXT
          )
        `, (err) => {
          if (err) console.error('Error creating attendance table:', err);
        });

        // สร้างตาราง users
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            line_user_id TEXT UNIQUE NOT NULL,
            display_name TEXT,
            department TEXT,
            position TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) console.error('Error creating users table:', err);
        });

        // สร้าง index
        db.run(`CREATE INDEX IF NOT EXISTS idx_user_date ON attendance(user_id, created_at)`, (err) => {
          if (err) console.error('Error creating index:', err);
          else {
            console.log('Database initialized successfully');
            resolve();
          }
        });
      });
    });
  });
}

// ฟังก์ชันรันคำสั่ง SQL
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        console.error('SQL Error:', err);
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
}

// ฟังก์ชันดึงข้อมูล SQL
function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('SQL Error:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// ฟังก์ชันสร้างวัน-เวลาไทย
function toISOStringThai(date = new Date()) {
  const offsetMs = 7 * 60 * 60 * 1000; // UTC+7
  const local = new Date(date.getTime() + offsetMs);
  const iso = local.toISOString().replace("Z", "+07:00");
  return iso;
}

// ฟังก์ชันคำนวณระยะทางระหว่างจุด 2 จุด (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // รัศมีโลกในหน่วยเมตร
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // ระยะทางในหน่วยเมตร
}

// ฟังก์ชันตรวจสอบว่าอยู่ในบริเวณสำนักงานหรือไม่
function isWithinOfficeArea(userLat, userLon) {
  const distance = calculateDistance(
    userLat, userLon, 
    OFFICE_LOCATION.latitude, OFFICE_LOCATION.longitude
  );
  //ตำแหน่งสำรองสำหรับ iOS
  const distance2 = calculateDistance(
    userLat, userLon, 
    14.995906, 102.107861
  );
  return distance <= OFFICE_LOCATION.radius || distance2 <= OFFICE_LOCATION.radius;
}

// สร้าง LIFF URL Message
/*function createLiffMessage(req = null) {
  // ตรวจสอบ host จาก request หรือใช้ BASE_URL
  const baseUrl = req ? `https://${req.get('host')}` : BASE_URL;
  return {
    type: 'flex',
    altText: 'บันทึกเวลาเข้า-ออกงาน',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: `${baseUrl}/src/machine.png`,
        size: 'full',
        aspectRatio: '20:13'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'ระบบบันทึกเวลาทำงาน',
            weight: 'bold',
            size: 'xl',
            color: '#1E90FF'
          },
          {
            type: 'text',
            text: 'ระบบจะตรวจสอบตำแหน่งอัตโนมัติ',
            size: 'sm',
            color: '#666666',
            margin: 'md'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '🕘 เข้างาน',
              uri: `https://liff.line.me/2007882683-Mg5pj4m2?action=checkin`
            },
            color: '#28a745'
          },
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '🕕 ออกงาน',
              uri: `https://liff.line.me/2007882683-Mg5pj4m2?action=checkout`
            },
            color: '#dc3545'
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '📊 ดูประวัติ',
              data: 'action=history'
            }
          }
        ]
      }
    }
  };
}*/

// บันทึกข้อมูลผู้ใช้ (ถ้ายังไม่มี)
async function saveUserInfo(userId, displayName) {
  try {
    await runQuery(
      `INSERT OR IGNORE INTO users (line_user_id, display_name, created_at) 
       VALUES (?, ?, ?)`,
      [userId, displayName, toISOStringThai()]
    );
  } catch (error) {
    console.error('Error saving user info:', error);
  }
}

// จัดการการลงเวลาผ่าน LINE Chat (ไม่ตรวจสอบ GPS)
/*async function handleChatAttendance(userId, action, displayName) {
  const timestamp = new Date().toISOString();
  const today = new Date().toDateString();
  
  console.log(`📱 Chat attendance: ${action} for user ${userId} (${displayName})`);
  
  try {
    // ตรวจสอบข้อมูลวันนี้
    const rows = await getQuery(
      `SELECT * FROM attendance 
       WHERE user_id = ? AND date(created_at) = date('now', 'localtime') 
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    console.log(`Found ${rows.length} existing records for today`);
    
    if (action === 'checkin') {
      if (rows.length > 0 && rows[0].checkin_time) {
        throw new Error('คุณได้บันทึกเข้างานวันนี้แล้ว');
      }
      
      // บันทึกเข้างาน (ไม่มี GPS)
      const result = await runQuery(
        `INSERT INTO attendance (user_id, checkin_time, checkin_lat, checkin_lon, created_at) 
         VALUES (?, ?, ?, ?, ?)`,
        [userId, timestamp, null, null, timestamp]
      );
      
      console.log(`✅ Chat check-in recorded with ID: ${result.lastID}`);
      
      const time = new Date().toLocaleString('th-TH', { 
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      return {
        success: true,
        message: `🕘 บันทึกเข้างานสำเร็จ\n👤 ${displayName}\n⏰ เวลา: ${time}\n📍 ลงเวลาผ่านแชท LINE\n\n💡 หมายเหตุ: ไม่ได้ตรวจสอบตำแหน่ง GPS`
      };
      
    } else if (action === 'checkout') {
      if (rows.length === 0 || !rows[0].checkin_time) {
        throw new Error('กรุณาบันทึกเข้างานก่อน');
      }
      
      if (rows[0].checkout_time) {
        throw new Error('คุณได้บันทึกออกงานวันนี้แล้ว');
      }
      
      // บันทึกออกงาน (ไม่มี GPS)
      const result = await runQuery(
        `UPDATE attendance 
         SET checkout_time = ?, checkout_lat = ?, checkout_lon = ? 
         WHERE id = ?`,
        [timestamp, null, null, rows[0].id]
      );
      
      console.log(`✅ Chat check-out recorded, updated ${result.changes} rows`);
      
      const time = new Date().toLocaleString('th-TH', { 
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      // คำนวณชั่วโมงทำงาน
      const checkinTime = new Date(rows[0].checkin_time);
      const checkoutTime = new Date(timestamp);
      const workHours = ((checkoutTime - checkinTime) / (1000 * 60 * 60)).toFixed(1);
      
      return {
        success: true,
        message: `🕕 บันทึกออกงานสำเร็จ\n👤 ${displayName}\n⏰ เวลา: ${time}\n📍 ลงเวลาผ่านแชท LINE\n⏱️ ชั่วโมงทำงาน: ${workHours} ชั่วโมง\n\n💡 หมายเหตุ: ไม่ได้ตรวจสอบตำแหน่ง GPS`
      };
    } else {
      throw new Error('การกระทำไม่ถูกต้อง');
    }
  } catch (error) {
    console.error('Chat attendance error:', error);
    throw error;
  }
}*/

// จัดการข้อความจาก LINE
async function handleEvent(event) {
  if (event.type !== 'message' && event.type !== 'postback') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const baseUrl = "https://stackblitz.com/~/github.com/hyghyn9/time-attendance";
  // บันทึกข้อมูลผู้ใช้ถ้ามี
  let profile;
  try {
    profile = await client.getProfile(userId);
    await saveUserInfo(userId, profile.displayName);
  } catch (error) {
    console.error('Error getting user profile:', error);
    profile = { displayName: 'Unknown User' };
  }
  
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.toLowerCase().trim();
    
    if (text === 'admin') {
      // ลิงค์เข้าหน้า admin
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `${baseUrl}/dashboard.html`
      });
    } /*else if (text === 'ประวัติ') {
      // แสดงประวัติการทำงาน
      const history = await getAttendanceHistory(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📊 ประวัติการทำงานของ ${profile.displayName}\n\n${history}`
      });
    } else if (text === 'help') {
      // คำสั่งช่วยเหลือ
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📚 คำสั่งที่ใช้ได้:\n\n🔹 "ลงเวลา" หรือ "เวลา" - บันทึกเวลา เข้า-ออกงาน\n🔹 "ประวัติ" - ดูประวัติการทำงาน\n🔹 "help" - แสดงคำสั่งนี้\n\n📍 หมายเหตุ: ระบบจะตรวจสอบตำแหน่ง GPS ก่อนให้บันทึกเวลา`
      });
    } else if (text === 'ลงเวลา') {
      console.log(`Sending LIFF message to user: ${userId}`);
      return client.replyMessage(event.replyToken, createLiffMessage());
    } /*else {
      // ข้อความทั่วไป
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `สวัสดี ${profile.displayName}! 👋\n\n🔹 พิมพ์ "ลงเวลา" - บันทึกเวลา เข้า-ออกงาน\n🔹 พิมพ์ "ประวัติ" - ดูประวัติ\n🔹 พิมพ์ "help" - ดูคำสั่งทั้งหมด`
      });
    }*/
  }
  
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    
    if (action === 'history') {
      const history = await getAttendanceHistory(userId);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: history
      });
    }
  }
  
  return Promise.resolve(null);
}


// API สำหรับบันทึกเวลา
app.post('/api/attendance', express.json(), async (req, res) => {
  try {
    console.log('=== Attendance API Called ===');
    console.log('Raw headers:', req.headers);
    console.log('Request body:', req.body);
    console.log('Content-Type:', req.headers['content-type']);
    
    // ตรวจสอบว่ามี body หรือไม่
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
      console.log('❌ Empty request body');
      return res.json({
        success: false,
        message: 'ไม่มีข้อมูลในคำขอ กรุณาตรวจสอบ Content-Type header'
      });
    }
    
    const { userId, action, latitude, longitude } = req.body;
    
    // ตรวจสอบข้อมูลที่จำเป็น
    if (!userId || !action || latitude === undefined || longitude === undefined) {
      console.log('❌ Missing required fields:', { userId, action, latitude, longitude });
      return res.json({
        success: false,
        message: `ข้อมูลไม่ครบถ้วน\nได้รับ: userId=${userId}, action=${action}, lat=${latitude}, lon=${longitude}`
      });
    }
    
    console.log('✅ Data validation passed');
    console.log(`📍 User location: ${latitude}, ${longitude}`);
    console.log(`🏢 Office location: ${OFFICE_LOCATION.latitude}, ${OFFICE_LOCATION.longitude}`);
    
    // ตรวจสอบตำแหน่ง
    const distance = calculateDistance(
      latitude, longitude,
      OFFICE_LOCATION.latitude, OFFICE_LOCATION.longitude
    );
    
    console.log(`📏 Distance: ${Math.round(distance)} meters`);
    console.log(`📏 Radius limit: ${OFFICE_LOCATION.radius} meters`);
	
    //ทดสอบนอกสถานที่จึง comment ไว้ก่อน
    if (!isWithinOfficeArea(latitude, longitude)) {
      console.log('❌ Outside office area');
      return res.json({
        success: false,
        message: `❌ คุณไม่อยู่ในบริเวณสำนักงาน\nระยะห่าง: ${Math.round(distance)} เมตร\n(ต้องอยู่ภายใน ${OFFICE_LOCATION.radius} เมตร)`,
        distance: Math.round(distance),
        userLocation: { latitude, longitude },
        officeLocation: OFFICE_LOCATION
      });
    }
    
    console.log('✅ Location validation passed');
    
    // บันทึกเวลา
    await recordAttendance(userId, action, latitude, longitude);
    
    const actionText = action === 'checkin' ? 'เข้างาน' : 'ออกงาน';
    const emoji = action === 'checkin' ? '🕘' : '🕕';
    const time = new Date().toLocaleString('th-TH', { 
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    console.log(`✅ ${actionText} recorded successfully`);
    
    res.json({
      success: true,
      message: `${emoji} บันทึก${actionText}สำเร็จ\n⏰ เวลา: ${time}\n📍 ระยะห่าง: ${Math.round(distance)} เมตร`,
      timestamp: time,
      action: action,
      distance: Math.round(distance)
    });
    
  } catch (error) {
    console.error('❌ API Error:', error);
    res.json({
      success: false,
      message: error.message || 'เกิดข้อผิดพลาดในการบันทึก',
      error: error.toString()
    });
  }
});

// API สำหรับดูสถานะวันนี้
app.get('/api/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`Getting status for user: ${userId}`);
    
    const rows = await getQuery(
      `SELECT * FROM attendance 
       WHERE user_id = ? AND date(created_at,"+7 hours") = date('now', 'localtime') 
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    let status = {
      checkedIn: false,
      checkedOut: false,
      checkinTime: null,
      checkoutTime: null
    };
    
    if (rows.length > 0) {
      const row = rows[0];
      status.checkedIn = !!row.checkin_time;
      status.checkedOut = !!row.checkout_time;
      status.checkinTime = row.checkin_time;
      status.checkoutTime = row.checkout_time;
    }
    
    console.log(`Status for ${userId}:`, status);
    res.json({ success: true, status });
    
  } catch (error) {
    console.error('Status API Error:', error);
    res.json({ 
      success: false, 
      message: 'เกิดข้อผิดพลาด',
      error: error.toString()
    });
  }
});

// ฟังก์ชันบันทึกเวลา
async function recordAttendance(userId, action, latitude, longitude) {
  //const timestamp = new Date().toISOString();
  const timestamp = toISOStringThai();
  
  try {
    console.log(`Recording ${action} for user ${userId}`);
    
    // ตรวจสอบข้อมูลวันนี้
    const rows = await getQuery(
      `SELECT * FROM attendance 
       WHERE user_id = ? AND date(created_at,"+7 hours") = date('now', 'localtime') 
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    console.log(`Found ${rows.length} existing records for today`);
    
    if (action === 'checkin') {
      if (rows.length > 0 && rows[0].checkin_time) {
        throw new Error('คุณได้บันทึกเข้างานวันนี้แล้ว');
      }
      
      const result = await runQuery(
        `INSERT INTO attendance (user_id, checkin_time, checkin_lat, checkin_lon, created_at) 
         VALUES (?, ?, ?, ?, ?)`,
        [userId, timestamp, latitude, longitude, timestamp]
      );
      
      console.log(`✅ Check-in recorded with ID: ${result.lastID}`);
      
    } else if (action === 'checkout') {
      if (rows.length === 0 || !rows[0].checkin_time) {
        throw new Error('กรุณาบันทึกเข้างานก่อน');
      }
      
      if (rows[0].checkout_time) {
        throw new Error('คุณได้บันทึกออกงานวันนี้แล้ว');
      }
      
      const result = await runQuery(
        `UPDATE attendance 
         SET checkout_time = ?, checkout_lat = ?, checkout_lon = ? 
         WHERE id = ?`,
        [timestamp, latitude, longitude, rows[0].id]
      );
      
      console.log(`✅ Check-out recorded, updated ${result.changes} rows`);
      
    } else {
      throw new Error('การกระทำไม่ถูกต้อง');
    }
  } catch (error) {
    console.error('Database error:', error);
    throw error;
  }
}

// ฟังก์ชันดูประวัติการทำงาน
async function getAttendanceHistory(userId) {
  try {
    const rows = await getQuery(
      `SELECT * FROM attendance 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 7`,
      [userId]
    );
    
    if (rows.length === 0) {
      return '📊 ไม่มีประวัติการทำงาน';
    }
    
    let history = '📊 ประวัติการทำงาน 7 วันล่าสุด\n\n';
    
    rows.forEach(row => {
      const date = new Date(row.created_at).toLocaleDateString('th-TH', {
        timeZone: 'Asia/Bangkok'
      });
      const checkinTime = row.checkin_time ? 
        new Date(row.checkin_time).toLocaleTimeString('th-TH', { 
          timeZone: 'Asia/Bangkok',
          hour: '2-digit', 
          minute: '2-digit' 
        }) : '-';
      const checkoutTime = row.checkout_time ? 
        new Date(row.checkout_time).toLocaleTimeString('th-TH', { 
          timeZone: 'Asia/Bangkok',
          hour: '2-digit', 
          minute: '2-digit' 
        }) : '-';
      
      // คำนวณชั่วโมงทำงาน
      let workHours = '-';
      if (row.checkin_time && row.checkout_time) {
        const checkin = new Date(row.checkin_time);
        const checkout = new Date(row.checkout_time);
        const diffMs = checkout - checkin;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        workHours = `${hours}:${minutes.toString().padStart(2, '0')} ชม.`;
      }
      
      history += `📅 ${date}\n`;
      history += `🕘 เข้า: ${checkinTime}\n`;
      history += `🕕 ออก: ${checkoutTime}\n`;
      history += `⏱️ รวม: ${workHours}\n\n`;
    });
    
    return history;
  } catch (error) {
    console.error('Database error:', error);
    return '❌ เกิดข้อผิดพลาดในการดึงข้อมูล';
  }
}

// Middleware สำหรับ parsing JSON และ URL encoded
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static('public'));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Debug middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', req.body);
  }
  next();
});

// Root route - serve LIFF app
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  console.log('Serving index.html from:', indexPath);
  res.sendFile(indexPath);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    time: new Date().toISOString(),
    database: DB_PATH,
    office: OFFICE_LOCATION,
    uptime: process.uptime()
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'Server is working!',
    timestamp: new Date().toISOString(),
    office: OFFICE_LOCATION
  });
});

// Admin API - ดึงข้อมูลผู้ใช้ทั้งหมด
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await getQuery('SELECT * FROM users ORDER BY display_name');
    res.json({ success: true, users });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.json({ success: false, message: error.message });
  }
});

// Admin API - ดึงข้อมูลการบันทึกเวลาแบบมีตัวกรอง
app.get('/api/admin/attendance', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      userFilter,
      statusFilter,
      sortBy = 'created_at_desc'
    } = req.query;
	//console.log(dateFrom,dateTo);
    let sql = `
      SELECT a.*, u.display_name 
      FROM attendance a 
      LEFT JOIN users u ON a.user_id = u.line_user_id
      WHERE 1=1
    `;
    const params = [];

    // กรองตามวันที่
    if (dateFrom) {
      sql += ` AND date(a.created_at,"+7 hours") >= date(?)`;
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ` AND date(a.created_at,"+7 hours") <= date(?)`;
      params.push(dateTo);
    }

    // กรองตามผู้ใช้
    if (userFilter) {
      sql += ` AND (a.user_id LIKE ? OR u.display_name LIKE ?)`;
      params.push(`%${userFilter}%`, `%${userFilter}%`);
    }

    // กรองตามสถานะ
    if (statusFilter === 'complete') {
      sql += ` AND a.checkin_time IS NOT NULL AND a.checkout_time IS NOT NULL`;
    } else if (statusFilter === 'partial') {
      sql += ` AND (a.checkin_time IS NULL OR a.checkout_time IS NULL)`;
    } else if (statusFilter === 'checkin_only') {
      sql += ` AND a.checkin_time IS NOT NULL AND a.checkout_time IS NULL`;
    } else if (statusFilter === 'not_complete') {
      sql += ` AND a.checkin_time IS NULL AND a.checkout_time IS NULL`;
    }

    // เรียงลำดับ
    const sortOptions = {
      'created_at_desc': 'ORDER BY a.created_at DESC',
      'created_at_asc': 'ORDER BY a.created_at ASC', 
      'user_id_asc': 'ORDER BY a.user_id ASC',
      'checkin_time_asc': 'ORDER BY a.checkin_time ASC'
    };
    sql += ` ${sortOptions[sortBy] || sortOptions['created_at_desc']}`;

    const data = await getQuery(sql, params);
    res.json({ success: true, data });

  } catch (error) {
    console.error('Error fetching attendance data:', error);
    res.json({ success: false, message: error.message });
  }
});

// Admin API - จัดการพนักงาน CRUD
// เพิ่มพนักงานใหม่
app.post('/api/admin/users', async (req, res) => {
  try {
    const { line_user_id, display_name, department, position } = req.body;
    
    if (!line_user_id || !display_name) {
      return res.json({ success: false, message: 'กรุณากรอก Line User ID และชื่อ' });
    }

    const result = await runQuery(
      `INSERT INTO users (line_user_id, display_name, department, position, created_at) 
       VALUES (?, ?, ?, ?, ?)`,
      [line_user_id, display_name, department || '', position || '', new Date().toISOString()]
    );

    res.json({ success: true, message: 'เพิ่มพนักงานสำเร็จ', id: result.lastID });
  } catch (error) {
    console.error('Error adding user:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.json({ success: false, message: 'User ID นี้มีอยู่แล้วในระบบ' });
    } else {
      res.json({ success: false, message: error.message });
    }
  }
});

// แก้ไขข้อมูลพนักงาน
app.put('/api/admin/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, department, position } = req.body;

    if (!display_name) {
      return res.json({ success: false, message: 'กรุณากรอกชื่อ' });
    }

    const result = await runQuery(
      `UPDATE users SET display_name = ?, department = ?, position = ? WHERE id = ?`,
      [display_name, department || '', position || '', id]
    );

    if (result.changes > 0) {
      res.json({ success: true, message: 'อัปเดตข้อมูลสำเร็จ' });
    } else {
      res.json({ success: false, message: 'ไม่พบพนักงานที่ต้องการแก้ไข' });
    }
  } catch (error) {
    console.error('Error updating user:', error);
    res.json({ success: false, message: error.message });
  }
});

// ลบพนักงาน
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // ตรวจสอบว่ามีการบันทึกเวลาหรือไม่
    const attendanceCount = await getQuery(
      'SELECT COUNT(*) as count FROM attendance WHERE user_id IN (SELECT line_user_id FROM users WHERE id = ?)',
      [id]
    );

    if (attendanceCount[0].count > 0) {
      return res.json({ 
        success: false, 
        message: `ไม่สามารถลบได้ เพราะพนักงานนี้มีการบันทึกเวลา ${attendanceCount[0].count} ครั้ง` 
      });
    }

    const result = await runQuery('DELETE FROM users WHERE id = ?', [id]);
    
    if (result.changes > 0) {
      res.json({ success: true, message: 'ลบพนักงานสำเร็จ' });
    } else {
      res.json({ success: false, message: 'ไม่พบพนักงานที่ต้องการลบ' });
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    res.json({ success: false, message: error.message });
  }
});

// Admin API - จัดการข้อมูลการบันทึกเวลา CRUD
// เพิ่มการบันทึกเวลาใหม่
app.post('/api/admin/attendance', async (req, res) => {
  try {
    const { user_id, checkin_time, checkout_time, checkin_lat, checkin_lon, checkout_lat, checkout_lon, note } = req.body;
    
    if (!user_id) {
      return res.json({ success: false, message: 'กรุณาเลือกพนักงาน' });
    }

    // ตรวจสอบว่า user มีอยู่จริง
    const userExists = await getQuery('SELECT id FROM users WHERE line_user_id = ?', [user_id]);
    if (userExists.length === 0) {
      return res.json({ success: false, message: 'ไม่พบพนักงานในระบบ' });
    }

    //const created_at = checkin_time || new Date().toISOString();
	const created_at = checkin_time || toISOStringThai();

    const result = await runQuery(
      `INSERT INTO attendance (user_id, checkin_time, checkout_time, checkin_lat, checkin_lon, checkout_lat, checkout_lon, created_at, note) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user_id, checkin_time || null, checkout_time || null, 
       checkin_lat || null, checkin_lon || null, checkout_lat || null, checkout_lon || null, created_at, note || null]
    );

    res.json({ success: true, message: 'เพิ่มการบันทึกเวลาสำเร็จ', id: result.lastID });
  } catch (error) {
    console.error('Error adding attendance:', error);
    res.json({ success: false, message: error.message });
  }
});

// แก้ไขการบันทึกเวลา
app.put('/api/admin/attendance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { checkin_time, checkout_time, checkin_lat, checkin_lon, checkout_lat, checkout_lon, note } = req.body;

    const result = await runQuery(
      `UPDATE attendance SET 
       checkin_time = ?, checkout_time = ?, 
       checkin_lat = ?, checkin_lon = ?, checkout_lat = ?, checkout_lon = ?, note = ? 
       WHERE id = ?`,
      [checkin_time || null, checkout_time || null, 
       checkin_lat || null, checkin_lon || null, checkout_lat || null, checkout_lon || null, note || null, id]
    );

    if (result.changes > 0) {
      res.json({ success: true, message: 'อัปเดตการบันทึกเวลาสำเร็จ' });
    } else {
      res.json({ success: false, message: 'ไม่พบการบันทึกเวลาที่ต้องการแก้ไข' });
    }
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.json({ success: false, message: error.message });
  }
});

// ลบการบันทึกเวลา
app.delete('/api/admin/attendance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await runQuery('DELETE FROM attendance WHERE id = ?', [id]);
    
    if (result.changes > 0) {
      res.json({ success: true, message: 'ลบการบันทึกเวลาสำเร็จ' });
    } else {
      res.json({ success: false, message: 'ไม่พบการบันทึกเวลาที่ต้องการลบ' });
    }
  } catch (error) {
    console.error('Error deleting attendance:', error);
    res.json({ success: false, message: error.message });
  }
});

// Admin API - Export ข้อมูลเป็น Excel
app.get('/api/admin/export', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      userFilter,
      statusFilter,
      sortBy = 'created_at_desc'
    } = req.query;

    // ใช้ query เดียวกับ API attendance
    /*let sql = `
      SELECT a.*, u.display_name 
      FROM attendance a 
      LEFT JOIN users u ON a.user_id = u.line_user_id
      WHERE 1=1
    `;*/
    let sql = `
      WITH date_range AS (
        SELECT 
          date(COALESCE(?, MIN(a.created_at))) AS min_date,
          date(COALESCE(?, MAX(a.created_at))) AS max_date
        FROM attendance a
      ),
      recursive_dates AS (
        SELECT min_date AS d FROM date_range
        UNION ALL
        SELECT date(d, '+1 day')
        FROM recursive_dates, date_range
        WHERE d < max_date
      ),
      user_dates AS (
        SELECT u.line_user_id, u.display_name, r.d
        FROM users u
        CROSS JOIN recursive_dates r
      )
      SELECT 
        ud.display_name,
        ud.line_user_id AS user_id,
        ud.d AS target_date,
        a.checkin_time,
        a.checkout_time,
        a.note,
        a.checkin_lat,
        a.checkin_lon,
        a.checkout_lat,
        a.checkout_lon,
        a.created_at
      FROM user_dates ud
      LEFT JOIN attendance a 
        ON ud.line_user_id = a.user_id
        AND date(a.created_at) = ud.d
      WHERE 1=1
    `;
    /*const params = [];*/
    const params = [ dateFrom || null, dateTo || null  ];

    /*if (dateFrom) {
      sql += ` AND date(a.created_at) >= date(?)`;
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ` AND date(a.created_at) <= date(?)`;
      params.push(dateTo);
    }*/
    if (userFilter) {
      sql += ` AND (a.user_id LIKE ? OR u.display_name LIKE ?)`;
      params.push(`%${userFilter}%`, `%${userFilter}%`);
    }
    if (statusFilter === 'complete') {
      sql += ` AND a.checkin_time IS NOT NULL AND a.checkout_time IS NOT NULL`;
    } else if (statusFilter === 'partial') {
      sql += ` AND (a.checkin_time IS NULL OR a.checkout_time IS NULL)`;
    } else if (statusFilter === 'checkin_only') {
      sql += ` AND a.checkin_time IS NOT NULL AND a.checkout_time IS NULL`;
    }

    const sortOptions = {
      '-': 'ORDER BY ud.display_name , ud.d ASC',
      'created_at_desc': 'ORDER BY a.created_at DESC',
      'created_at_asc': 'ORDER BY a.created_at ASC', 
      'user_id_asc': 'ORDER BY a.user_id ASC',
      'checkin_time_asc': 'ORDER BY a.checkin_time ASC'
    };
    sql += ` ${sortOptions[sortBy] || sortOptions['created_at_desc']}`;

    const data = await getQuery(sql, params);

    // แปลงข้อมูลสำหรับ Excel
    const excelData = data.map(record => {
      // คำนวณชั่วโมงทำงาน
      let workHours = '';
      if (record.checkin_time && record.checkout_time) {
        const checkinTime = new Date(record.checkin_time);
        const checkoutTime = new Date(record.checkout_time);
        const diffMs = checkoutTime - checkinTime;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        workHours = `${hours}:${minutes.toString().padStart(2, '0')}`;
      }

      // กำหนดสถานะ
      let status = '';
      if (record.checkin_time && record.checkout_time) {
        status = 'ครบถ้วน';
      } else if (record.checkin_time) {
        status = 'เข้างานอย่างเดียว';
      } else {
        status = 'ไม่สมบูรณ์';
      }

      return {
        'วันที่': record.target_date ? new Date(record.target_date).toLocaleDateString('th-TH') : '',
        'User ID': record.user_id || '',
        'ชื่อ': record.display_name || 'ไม่ทราบชื่อ',
        'เวลาเข้างาน': record.checkin_time ? new Date(record.checkin_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '',
        'เวลาออกงาน': record.checkout_time ? new Date(record.checkout_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '',
        'ชั่วโมงทำงาน': workHours,
        'สถานะ': status,
        'หมายเหตุ': record.note || '',
        'ตำแหน่งเข้างาน (Lat)': record.checkin_lat || '',
        'ตำแหน่งเข้างาน (Lng)': record.checkin_lon || '',
        'ตำแหน่งออกงาน (Lat)': record.checkout_lat || '',
        'ตำแหน่งออกงาน (Lng)': record.checkout_lon || ''
      };
    });

    // สร้าง workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // ปรับความกว้างของ column
    const colWidths = [
      { wch: 12 }, // วันที่
      { wch: 15 }, // User ID
      { wch: 20 }, // ชื่อ
      { wch: 12 }, // เวลาเข้า
      { wch: 12 }, // เวลาออก
      { wch: 12 }, // ชั่วโมง
      { wch: 15 }, // สถานะ
      { wch: 30 }, // หมายเหตุ
      { wch: 12 }, // Lat เข้า
      { wch: 12 }, // Lng เข้า
      { wch: 12 }, // Lat ออก
      { wch: 12 }  // Lng ออก
    ];
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, 'Attendance Report');

    // สร้าง buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // ส่งไฟล์
    const filename = `attendance_report_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.send(buffer);

  } catch (error) {
    console.error('Error exporting data:', error);
    res.json({ success: false, message: error.message });
  }
});

// LINE Webhook (แบบไม่ตรวจสอบ signature สำหรับทดสอบ)
app.post('/webhook', (req, res) => {
  console.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));
  
  if (!req.body.events || req.body.events.length === 0) {
    console.log('⚠️ No events in webhook');
    return res.json({ message: 'No events' });
  }
  
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => {
      console.log('✅ Webhook processed successfully:', result);
      res.json(result);
    })
    .catch((err) => {
      console.error('❌ Webhook error:', err);
      res.status(500).json({ error: err.message });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error middleware caught:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: err.message 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    url: req.url,
    method: req.method
  });
});

// เริ่มเซิร์ฟเวอร์
const port = process.env.PORT || 3000;

// เริ่มต้นฐานข้อมูลและเซิร์ฟเวอร์
initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log('='.repeat(60));
      console.log('🚀 LINE Attendance System Started Successfully!');
      console.log('='.repeat(60));
      console.log(`📡 Server URL: http://localhost:${port}`);
      console.log(`🗄️ Database: ${DB_PATH}`);
      console.log(`📍 Office Location: ${OFFICE_LOCATION.latitude}, ${OFFICE_LOCATION.longitude}`);
      console.log(`📏 Allowed Radius: ${OFFICE_LOCATION.radius} meters`);
      console.log(`🔗 LIFF ID: 2007882683-Mg5pj4m2`);
      console.log('='.repeat(60));
      console.log('🌐 Endpoints:');
      console.log(`   GET  /                    - LIFF App`);
      console.log(`   GET  /health              - Health Check`);
      console.log(`   GET  /test                - Test Endpoint`);
      console.log(`   POST /api/attendance      - Record Attendance`);
      console.log(`   GET  /api/status/:userId  - Get Status`);
      console.log(`   POST /webhook             - LINE Webhook`);
      console.log('='.repeat(60));
      console.log('📋 Next Steps:');
      console.log('1. ✅ Channel tokens configured');
      console.log('2. ✅ LIFF ID configured');
      console.log('3. ✅ Office location set (Nakhon Ratchasima)');
      console.log('4. 📄 Create public/index.html file');
      console.log('5. 🌐 Setup ngrok for testing');
      console.log('6. ⚙️ Configure LINE webhook URL');
      console.log('='.repeat(60));
    });
  })
  .catch((error) => {
    console.error('❌ Failed to initialize database:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (db) {
    db.close();
    console.log('Database connection closed');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  if (db) {
    db.close();
    console.log('Database connection closed');
  }
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ============================================================================
// ไฟล์ที่ต้องสร้าง: public/index.html
/*
<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ระบบบันทึกเวลาทำงาน</title>
    <script src="https://static.line-scdn.net/liff/edge/2.1/sdk.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 100%;
            text-align: center;
        }
        
        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            border-radius: 50%;
            margin: 0 auto 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 30px;
            color: white;
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 24px;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        
        .status {
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            font-weight: 500;
            font-size: 14px;
            line-height: 1.4;
        }
        
        .status.loading {
            background: #e3f2fd;
            color: #1976d2;
        }
        
        .status.success {
            background: #e8f5e8;
            color: #2e7d32;
        }
        
        .status.error {
            background: #ffebee;
            color: #c62828;
        }
        
        .btn {
            width: 100%;
            padding: 15px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-bottom: 10px;
        }
        
        .btn-checkin {
            background: linear-gradient(135deg, #4caf50, #45a049);
            color: white;
        }
        
        .btn-checkout {
            background: linear-gradient(135deg, #f44336, #d32f2f);
            color: white;
        }
        
        .btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .loading-spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #3498db;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 10px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .info-section {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
            font-size: 12px;
            color: #666;
            text-align: left;
        }
        
        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        
        .info-row:last-child {
            margin-bottom: 0;
        }
        
        .status-info {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            color: #856404;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 15px;
            font-size: 14px;
        }
        
        .debug-info {
            background: #e9ecef;
            padding: 10px;
            border-radius: 8px;
            font-size: 11px;
            color: #495057;
            text-align: left;
            font-family: monospace;
            margin-top: 15px;
            max-height: 200px;
            overflow-y: auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🕒</div>
        <h1>ระบบบันทึกเวลาทำงาน</h1>
        <p class="subtitle">ระบบตรวจสอบตำแหน่งอัตโนมัติ</p>
        
        <div id="status" class="status loading">
            <div class="loading-spinner"></div>
            กำลังเริ่มต้นระบบ...
        </div>
        
        <div id="todayStatus" class="status-info" style="display: none;"></div>
        
        <div id="buttons" style="display: none;">
            <button id="checkinBtn" class="btn btn-checkin">
                🕘 เข้างาน
            </button>
            <button id="checkoutBtn" class="btn btn-checkout">
                🕕 ออกงาน
            </button>
        </div>
        
        <div id="locationInfo" class="info-section" style="display: none;">
            <div class="info-row">
                <span>📍 ตำแหน่งปัจจุบัน:</span>
                <span id="coordinates">-</span>
            </div>
            <div class="info-row">
                <span>🏢 ระยะห่างจากออฟฟิศ:</span>
                <span id="distance">-</span>
            </div>
            <div class="info-row">
                <span>🎯 ความแม่นยำ GPS:</span>
                <span id="accuracy">-</span>
            </div>
        </div>
        
        <div id="debugInfo" class="debug-info" style="display: none;"></div>
    </div>

    <script>
        let currentPosition = null;
        let liffData = null;
        let todayStatus = null;
        const LIFF_ID = '2007882683-Mg5pj4m2';
        
        // Debug function
        function debugLog(message, data = null) {
            console.log(message, data);
            const debugEl = document.getElementById('debugInfo');
            const timestamp = new Date().toLocaleTimeString();
            debugEl.innerHTML += `[${timestamp}] ${message}\n`;
            if (data) {
                debugEl.innerHTML += JSON.stringify(data, null, 2) + '\n';
            }
            debugEl.innerHTML += '\n';
            debugEl.scrollTop = debugEl.scrollHeight;
        }

        // เริ่มต้น LIFF
        async function initializeLiff() {
            try {
                debugLog('Starting LIFF initialization...');
                showStatus('กำลังเริ่มต้น LIFF...', 'loading');
                
                await liff.init({ liffId: LIFF_ID });
                debugLog('LIFF initialized successfully');
                
                if (!liff.isLoggedIn()) {
                    debugLog('User not logged in, redirecting to login...');
                    liff.login();
                    return;
                }
                
                showStatus('กำลังดึงข้อมูลผู้ใช้...', 'loading');
                
                // ดึงข้อมูลผู้ใช้
                const profile = await liff.getProfile();
                liffData = {
                    userId: profile.userId,
                    displayName: profile.displayName
                };
                
                debugLog('User profile loaded:', liffData);
                
                // ตรวจสอบว่าเรียกจาก LINE หรือ browser
                if (liff.isInClient()) {
                    debugLog('Running inside LINE app');
                } else {
                    debugLog('Running in external browser');
                    // แสดง debug info เมื่อรันใน browser
                    document.getElementById('debugInfo').style.display = 'block';
                }
                
                // ดึงสถานะวันนี้
                await getTodayStatus();
                
                // ดึงพารามิเตอร์จาก URL
                const urlParams = new URLSearchParams(window.location.search);
                const action = urlParams.get('action');
                debugLog('URL action parameter:', action);
                
                // เริ่มตรวจสอบตำแหน่ง
                await getCurrentLocation();
                
                // ถ้ามี action จาก URL ให้ทำทันที
                if (action && currentPosition) {
                    debugLog('Auto-executing action:', action);
                    await recordAttendance(action);
                } else {
                    showButtons();
                }
                
            } catch (error) {
                debugLog('LIFF initialization failed:', error);
                showStatus('เกิดข้อผิดพลาดในการเริ่มต้นระบบ: ' + error.message, 'error');
            }
        }

        // ดึงสถานะวันนี้
        async function getTodayStatus() {
            try {
                debugLog('Getting today status for user:', liffData.userId);
                const response = await fetch(`/api/status/${liffData.userId}`);
                const result = await response.json();
                
                debugLog('Today status response:', result);
                
                if (result.success) {
                    todayStatus = result.status;
                    updateStatusDisplay();
                } else {
                    debugLog('Failed to get today status:', result.message);
                }
            } catch (error) {
                debugLog('Error getting today status:', error);
            }
        }

        // อัปเดตการแสดงสถานะวันนี้
        function updateStatusDisplay() {
            const statusEl = document.getElementById('todayStatus');
            
            if (todayStatus) {
                let statusText = '';
                
                if (todayStatus.checkedIn && todayStatus.checkedOut) {
                    const checkinTime = new Date(todayStatus.checkinTime).toLocaleTimeString('th-TH', {
                        hour: '2-digit', minute: '2-digit'
                    });
                    const checkoutTime = new Date(todayStatus.checkoutTime).toLocaleTimeString('th-TH', {
                        hour: '2-digit', minute: '2-digit'
                    });
                    statusText = `✅ วันนี้: เข้า ${checkinTime} | ออก ${checkoutTime}`;
                } else if (todayStatus.checkedIn) {
                    const checkinTime = new Date(todayStatus.checkinTime).toLocaleTimeString('th-TH', {
                        hour: '2-digit', minute: '2-digit'
                    });
                    statusText = `🟡 วันนี้: เข้างานแล้ว ${checkinTime}`;
                } else {
                    statusText = '⚪ วันนี้: ยังไม่ได้บันทึกเวลา';
                }
                
                statusEl.textContent = statusText;
                statusEl.style.display = 'block';
                
                debugLog('Status display updated:', statusText);
            }
        }

        // ดึงตำแหน่งปัจจุบัน
        function getCurrentLocation() {
            return new Promise((resolve, reject) => {
                if (!navigator.geolocation) {
                    debugLog('Geolocation not supported');
                    showStatus('เบราว์เซอร์ไม่รองรับ GPS', 'error');
                    reject('Geolocation not supported');
                    return;
                }

                showStatus('กำลังตรวจสอบตำแหน่ง...', 'loading');
                debugLog('Requesting geolocation...');

                const options = {
                    enableHighAccuracy: true,
                    timeout: 15000,
                    maximumAge: 60000
                };

                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        currentPosition = {
                            latitude: position.coords.latitude,
                            longitude: position.coords.longitude,
                            accuracy: position.coords.accuracy
                        };
                        
                        debugLog('Location obtained:', currentPosition);
                        
                        // คำนวณระยะห่าง
                        const officeLocation = {
                            latitude: 15.060962954548874,
                            longitude: 102.14972276638413
                        };
                        
                        const distance = calculateDistance(
                            currentPosition.latitude,
                            currentPosition.longitude,
                            officeLocation.latitude,
                            officeLocation.longitude
                        );
                        
                        debugLog('Calculated distance:', distance + ' meters');
                        
                        // อัปเดต UI
                        document.getElementById('coordinates').textContent = 
                            `${currentPosition.latitude.toFixed(6)}, ${currentPosition.longitude.toFixed(6)}`;
                        document.getElementById('distance').textContent = 
                            `${Math.round(distance)} เมตร`;
                        document.getElementById('accuracy').textContent = 
                            `±${Math.round(currentPosition.accuracy)} เมตร`;
                        document.getElementById('locationInfo').style.display = 'block';
                        
                        if (distance <= 100) {
                            showStatus('✅ ตรวจพบตำแหน่งสำเร็จ - อยู่ในบริเวณที่อนุญาต', 'success');
                        } else {
                            showStatus(`⚠️ ตรวจพบตำแหน่งสำเร็จ - นอกบริเวณที่อนุญาต (${Math.round(distance)}ม.)`, 'error');
                        }
                        
                        resolve(currentPosition);
                    },
                    (error) => {
                        debugLog('Geolocation error:', error);
                        let message = 'ไม่สามารถดึงตำแหน่งได้';
                        switch(error.code) {
                            case error.PERMISSION_DENIED:
                                message = 'กรุณาอนุญาตการเข้าถึงตำแหน่ง\nรีเฟรชหน้าเว็บและลองใหม่';
                                break;
                            case error.POSITION_UNAVAILABLE:
                                message = 'ตำแหน่งไม่พร้อมใช้งาน\nกรุณาตรวจสอบ GPS';
                                break;
                            case error.TIMEOUT:
                                message = 'หมดเวลาในการดึงตำแหน่ง\nกรุณาลองใหม่';
                                break;
                        }
                        showStatus(message, 'error');
                        reject(error);
                    },
                    options
                );
            });
        }

        // คำนวณระยะทาง (Haversine formula)
        function calculateDistance(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const φ1 = lat1 * Math.PI / 180;
            const φ2 = lat2 * Math.PI / 180;
            const Δφ = (lat2 - lat1) * Math.PI / 180;
            const Δλ = (lon2 - lon1) * Math.PI / 180;

            const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                      Math.cos(φ1) * Math.cos(φ2) *
                      Math.sin(Δλ/2) * Math.sin(Δλ/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

            return R * c;
        }

        // บันทึกเวลาทำงาน
        async function recordAttendance(action) {
            if (!currentPosition) {
                showStatus('ไม่พบตำแหน่งปัจจุบัน กรุณาลองใหม่', 'error');
                return;
            }

            const actionText = action === 'checkin' ? 'เข้างาน' : 'ออกงาน';
            showStatus(`กำลังบันทึก${actionText}...`, 'loading');
            
            debugLog(`Recording attendance: ${action}`, {
                userId: liffData.userId,
                location: currentPosition
            });
            
            // ปิดปุ่ม
            document.getElementById('buttons').style.display = 'none';

            try {
                const requestData = {
                    userId: liffData.userId,
                    action: action,
                    latitude: currentPosition.latitude,
                    longitude: currentPosition.longitude
                };
                
                debugLog('Sending attendance request:', requestData);

                const response = await fetch('/api/attendance', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestData)
                });

                const result = await response.json();
                debugLog('Attendance response:', result);

                if (result.success) {
                    showStatus(result.message, 'success');
                    
                    // อัปเดตสถานะวันนี้
                    await getTodayStatus();
                    
                    // ปิด LIFF หลังจาก 3 วินาที
                    setTimeout(() => {
                        if (liff.isInClient()) {
                            debugLog('Closing LIFF window...');
                            liff.closeWindow();
                        } else {
                            debugLog('Running in browser, not closing window');
                        }
                    }, 3000);
                } else {
                    showStatus(result.message, 'error');
                    showButtons(); // แสดงปุ่มใหม่
                }

            } catch (error) {
                debugLog('Attendance recording failed:', error);
                showStatus('เกิดข้อผิดพลาดในการบันทึก\nกรุณาตรวจสอบการเชื่อมต่อ', 'error');
                showButtons(); // แสดงปุ่มใหม่
            }
        }

        // แสดงสถานะ
        function showStatus(message, type) {
            const statusEl = document.getElementById('status');
            
            if (type === 'loading') {
                statusEl.innerHTML = `<div class="loading-spinner"></div>${message}`;
            } else {
                statusEl.innerHTML = message;
            }
            
            statusEl.className = `status ${type}`;
            statusEl.style.display = 'block';
        }

        // แสดงปุ่ม
        function showButtons() {
            if (!todayStatus) return;
            
            const buttonsEl = document.getElementById('buttons');
            const checkinBtn = document.getElementById('checkinBtn');
            const checkoutBtn = document.getElementById('checkoutBtn');
            
            // ปรับปุ่มตามสถานะ
            if (todayStatus.checkedIn && todayStatus.checkedOut) {
                // บันทึกครบแล้ว
                checkinBtn.disabled = true;
                checkoutBtn.disabled = true;
                checkinBtn.textContent = '✅ เข้างานแล้ว';
                checkoutBtn.textContent = '✅ ออกงานแล้ว';
            } else if (todayStatus.checkedIn) {
                // เข้างานแล้ว ยังไม่ออก
                checkinBtn.disabled = true;
                checkoutBtn.disabled = false;
                checkinBtn.textContent = '✅ เข้างานแล้ว';
                checkoutBtn.textContent = '🕕 ออกงาน';
            } else {
                // ยังไม่เข้างาน
                checkinBtn.disabled = false;
                checkoutBtn.disabled = true;
                checkinBtn.textContent = '🕘 เข้างาน';
                checkoutBtn.textContent = '⏳ ออกงาน';
            }
            
            buttonsEl.style.display = 'block';
            
            // Event listeners
            checkinBtn.onclick = () => {
                if (!checkinBtn.disabled) recordAttendance('checkin');
            };
            
            checkoutBtn.onclick = () => {
                if (!checkoutBtn.disabled) recordAttendance('checkout');
            };
            
            debugLog('Buttons displayed with status:', {
                checkedIn: todayStatus.checkedIn,
                checkedOut: todayStatus.checkedOut
            });
        }

        // เริ่มต้นเมื่อโหลดหน้า
        window.addEventListener('load', () => {
            debugLog('Page loaded, initializing LIFF...');
            initializeLiff();
        });
        
        // Handle page visibility change
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && liffData) {
                debugLog('Page became visible, refreshing location...');
                getCurrentLocation().catch(console.error);
            }
        });
        
        // Handle errors
        window.addEventListener('error', (event) => {
            debugLog('JavaScript error:', event.error);
        });
        
        window.addEventListener('unhandledrejection', (event) => {
            debugLog('Unhandled promise rejection:', event.reason);
        });
    </script>
</body>
</html>
*/

// ============================================================================
// package.json
/*
{
  "name": "line-attendance-system",
  "version": "1.0.0",
  "description": "ระบบบันทึกเวลาเข้า-ออกงาน LINE Official Account + GPS + SQLite",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "tunnel": "ngrok http 3000"
  },
  "keywords": ["line", "attendance", "gps", "sqlite", "liff", "better-sqlite3"],
  "author": "Your Name",
  "license": "MIT",
  "dependencies": {
    "express": "^4.18.2",
    "@line/bot-sdk": "^7.5.2",
    "better-sqlite3": "^8.7.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
*/

// ============================================================================
// การติดตั้งและใช้งาน
/*
1. ติดตั้ง dependencies:
   npm install express @line/bot-sdk better-sqlite3

2. สร้างโฟลเดอร์และไฟล์:
   mkdir public
   # คัดลอกโค้ด HTML ด้านบนใส่ในไฟล์ public/index.html

3. รันโปรแกรม:
   node server.js

4. ตั้งค่า ngrok (สำหรับทดสอบ):
   ngrok http 3000
   # จะได้ URL เช่น https://abc123.ngrok.io

5. ตั้งค่า LINE Developer Console:
   - Webhook URL: https://abc123.ngrok.io/webhook
   - LIFF Endpoint URL: https://abc123.ngrok.io

6. ทดสอบ:
   - เพิ่มเพื่อน LINE Official Account
   - ส่งข้อความ "เวลา"
   - กดปุ่มเข้างาน/ออกงาน
   - ตรวจสอบใน Console log

7. Debug:
   - เปิด https://abc123.ngrok.io ใน browser เพื่อดู debug info
   - ตรวจสอบ console log ใน browser
   - ตรวจสอบ server log ใน terminal
*/