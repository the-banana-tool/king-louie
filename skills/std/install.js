#!/usr/bin/env node

/**
 * Installation script for king-louie-std-skill
 *
 * Usage:
 *   node install.js [--dev]
 *
 * Options:
 *   --dev    Install as symlink for development (default: copy files)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isDev = process.argv.includes('--dev');
const skillDir = __dirname;
const kingLouieDir = path.resolve(skillDir, '..', 'king-louie');
const targetDir = path.join(kingLouieDir, 'skills', 'std');

console.log('🔧 King Louie STD Skill Installer\n');
console.log(`Installation mode: ${isDev ? 'Development (symlink)' : 'Production (copy)'}`);
console.log(`Source: ${skillDir}`);
console.log(`Target: ${targetDir}\n`);

// Check if King Louie exists
if (!fs.existsSync(kingLouieDir)) {
  console.error(`❌ Error: King Louie directory not found at ${kingLouieDir}`);
  console.error('   Make sure this skill is in a sibling directory to king-louie');
  process.exit(1);
}

// Check if skills directory exists, create if not
const skillsDir = path.join(kingLouieDir, 'skills');
if (!fs.existsSync(skillsDir)) {
  console.log('📁 Creating skills directory...');
  fs.mkdirSync(skillsDir, { recursive: true });
}

// Remove existing installation if present
if (fs.existsSync(targetDir)) {
  console.log('🗑️  Removing existing installation...');

  // Check if it's a symlink
  const stats = fs.lstatSync(targetDir);
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(targetDir);
  } else {
    // It's a directory, remove recursively
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

if (isDev) {
  // Development install: create symlink
  console.log('🔗 Creating symbolic link...');

  if (process.platform === 'win32') {
    // Windows: use junction
    execSync(`mklink /J "${targetDir}" "${skillDir}"`, { stdio: 'inherit' });
  } else {
    // Unix: use symlink
    fs.symlinkSync(skillDir, targetDir, 'dir');
  }

  console.log('✅ Symlink created successfully!');
} else {
  // Production install: copy files
  console.log('📦 Copying files...');

  function copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      // Skip node_modules and hidden files
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  copyRecursive(skillDir, targetDir);
  console.log('✅ Files copied successfully!');
}

// Install dependencies
console.log('\n📦 Installing dependencies...');
try {
  execSync('npm install', {
    cwd: isDev ? skillDir : targetDir,
    stdio: 'inherit'
  });
  console.log('✅ Dependencies installed!');
} catch (error) {
  console.error('⚠️  Warning: Failed to install dependencies');
  console.error('   You may need to run "npm install" manually in:', isDev ? skillDir : targetDir);
}

console.log('\n✨ Installation complete!');
console.log('\n📝 Next steps:');
console.log('   1. Restart King Louie');
console.log('   2. Use /help in Telegram or UI to see the STD skill');
console.log('   3. Try: /std help');
console.log('\n💡 Development mode:', isDev ? 'Yes (changes will be reflected immediately)' : 'No (run install again to update)');
