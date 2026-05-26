/**
 * Skill file loading — reads partner-identity and user-profile from <DATA_DIR>/skills/
 *
 * IMPORTANT: skills are PER-USER WRITABLE DATA, not shipped content. They live in
 * DATA_DIR (project's data/ in dev, AppData/data/ in packaged), NOT in the project
 * root or resourcesPath. Two reasons:
 *   1. The packaged .exe's resourcesPath is read-only — `saveIdentitySkill` would
 *      throw at runtime if skills lived there.
 *   2. End users would inherit whatever skill content was on the dev box at package
 *      time — i.e. the dev's companion identity would ship inside every installer.
 *
 * skill-templates/ at the project root is the OPPOSITE — those are read-only
 * shipped seeds (date-night.md, intimacy-exploration.md, etc.) that DO live
 * alongside the bundled app and are correctly included via package.json's files
 * whitelist. Don't conflate the two.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

let skillsDir = '';
let userDataDir = '';

export function initSkills(dataDir: string): void {
  skillsDir = join(dataDir, 'skills');
  userDataDir = dataDir;
}

export function loadIdentitySkill(): string {
  const path = join(skillsDir, 'partner-identity', 'SKILL.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function loadUserProfileSkill(): string {
  const path = join(skillsDir, 'user-profile', 'SKILL.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function saveIdentitySkill(content: string): void {
  const path = join(skillsDir, 'partner-identity', 'SKILL.md');
  mkdirSync(join(skillsDir, 'partner-identity'), { recursive: true });
  writeFileSync(path, content);
}

export function saveUserProfileSkill(content: string): void {
  const path = join(skillsDir, 'user-profile', 'SKILL.md');
  mkdirSync(join(skillsDir, 'user-profile'), { recursive: true });
  writeFileSync(path, content);
}

export function loadUserInstructions(): string {
  const p = join(userDataDir, 'user-instructions.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function saveUserInstructions(content: string): void {
  const p = join(userDataDir, 'user-instructions.md');
  writeFileSync(p, content);
}
