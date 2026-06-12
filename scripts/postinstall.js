const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const clientDir = path.join(__dirname, '..', 'dashboard', 'client');

if (fs.existsSync(clientDir)) {
  console.log('Detected dashboard/client directory. Installing dashboard client dependencies...');
  try {
    const npmCmd = process.env.npm_execpath ? `"${process.execPath}" "${process.env.npm_execpath}"` : 'npm';
    execSync(`${npmCmd} install`, { cwd: clientDir, stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to install dashboard client dependencies:', err);
    process.exit(1);
  }
} else {
  console.log('Skipping dashboard client installation (not in development environment).');
}
