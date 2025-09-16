
# Lab Attendance System

A modern desktop application for tracking lab attendance with automated reporting and cloud integration.

## 🚀 Features

- **Clean Desktop Interface**: Modern Electron-based UI for easy sign-in/sign-out
- **Automated Reporting**: Weekly attendance reports sent via email every Saturday at 8 AM
- **Cloud Integration**: Automatic upload to Dropbox/OneDrive and Google Sheets sync
- **Student Management**: Easy addition/removal of lab members
- **Offline Capable**: Works without internet, syncs when connected
- **Single Executable**: Packaged as a standalone desktop app

## 🛠️ Tech Stack

- **Frontend**: Electron + HTML/CSS/JavaScript
- **Backend**: Node.js (embedded)
- **Database**: SQLite with better-sqlite3
- **Automation**: Node-cron for scheduling
- **APIs**: Google Sheets API, Dropbox API, OneDrive API
- **Email**: Nodemailer

## 📦 Installation

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Setup
```bash
# Clone the repository
git clone <repository-url>
cd attendance-app

# Install dependencies
npm install

# Start the application
npm start
```

## 🔧 Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Package as executable
npm run package
```

## 📋 Usage

1. **Sign In/Out**: Enter your UF ID or name and click the appropriate button
2. **Weekly Reports**: Automated emails sent every Saturday at 8 AM
3. **Admin Functions**: Manage student roster through the settings panel
4. **Data Backup**: Attendance data automatically synced to cloud storage

## 📁 Project Structure

```
attendance-app/
├── src/
│   ├── main.js          # Electron main process
│   ├── renderer.js      # Frontend logic
│   ├── database.js      # SQLite operations
│   ├── automation.js    # Email/cloud sync/scheduling
│   └── index.html       # User interface
├── package.json
├── attendance.db        # SQLite database (auto-created)
└── README.md
```

## ⚙️ Configuration

Create a `config.json` file in the root directory:

```json
{
  "email": {
    "smtp": "smtp.gmail.com",
    "user": "your-email@gmail.com",
    "password": "app-password"
  },
  "googleSheets": {
    "spreadsheetId": "your-spreadsheet-id"
  },
  "dropbox": {
    "accessToken": "your-access-token"
  }
}
```

## 📊 Database Schema

```sql
CREATE TABLE attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uf_id TEXT NOT NULL,
    name TEXT,
    action TEXT CHECK(action IN ('signin', 'signout')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE students (
    uf_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    active BOOLEAN DEFAULT 1
);
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🐛 Troubleshooting

### Common Issues
- **App won't start**: Ensure Node.js 18+ is installed
- **Database errors**: Check file permissions in the app directory
- **Email not sending**: Verify SMTP settings and app passwords
- **Google Sheets sync failing**: Check API credentials and sheet permissions

### Support
For issues or questions, please create an issue in the repository or contact the development team.

---

**Built for University of Florida SMILE LAB** 🐊