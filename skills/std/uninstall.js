#!/usr/bin/env node

/**
 * Uninstallation script for king-louie-std-skill
 */

const fs = require('fs');
const path = require('path');

const skillDir = __dirname;
const kingLouieDir = path.resolve(skillDir, '..', 'king-louie');
const targetDir = path.join(kingLouieDir, 'skills', 'std');

console.log('🗑️  King Louie STD Skill Uninstaller\n');

if (!fs.existsSync(targetDir)) {
  console.log('ℹ️  Skill is not installed (nothing to uninstall)');
  process.exit(0);
}

console.log(`Removing: ${targetDir}`);

try {
  // Check if it's a symlink
  const stats = fs.lstatSync(targetDir);
  if (stats.isSymbolicLink()) {
    console.log('🔗 Removing symbolic link...');
    fs.unlinkSync(targetDir);
  } else {
    console.log('📂 Removing directory...');
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  console.log('✅ Skill uninstalled successfully!');
  console.log('\n📝 Note: Your STD task database is stored in King Louie\'s user data directory');
  console.log('   and will not be deleted. To remove it, delete: <userData>/std-tasks.db');
} catch (error) {
  console.error('❌ Error uninstalling skill:', error.message);
  process.exit(1);
}
