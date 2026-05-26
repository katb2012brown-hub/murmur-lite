/**
 * Custom Skills — file-based skill storage for on-demand loading
 * Skills are .md files in data/skills/ with optional YAML frontmatter
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

let skillsDir = '';

export function initCustomSkills(dataDir: string): void {
  skillsDir = join(dataDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
}

export interface SkillSummary {
  name: string;
  slug: string;
  description: string;
}

export interface SkillFull extends SkillSummary {
  content: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseFrontmatter(raw: string): { description: string; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    const fm = match[1];
    const content = match[2].trim();
    const descMatch = fm.match(/description:\s*(.+)/);
    return { description: descMatch ? descMatch[1].trim() : '', content };
  }
  // No frontmatter — first line as description if short
  const lines = raw.trim().split('\n');
  if (lines.length > 1 && lines[0].length < 120 && !lines[0].startsWith('#')) {
    return { description: lines[0], content: lines.slice(1).join('\n').trim() };
  }
  return { description: '', content: raw.trim() };
}

export function listCustomSkills(): SkillSummary[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const slug = f.replace('.md', '');
      const raw = readFileSync(join(skillsDir, f), 'utf-8');
      const { description } = parseFrontmatter(raw);
      // Convert slug back to readable name
      const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { name, slug, description };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadCustomSkill(nameOrSlug: string): SkillFull | null {
  const slug = slugify(nameOrSlug);
  const filePath = join(skillsDir, slug + '.md');
  if (!existsSync(filePath)) {
    // Try exact match
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    const match = files.find(f => f.replace('.md', '').toLowerCase() === nameOrSlug.toLowerCase());
    if (!match) return null;
    const raw = readFileSync(join(skillsDir, match), 'utf-8');
    const { description, content } = parseFrontmatter(raw);
    const name = match.replace('.md', '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { name, slug: match.replace('.md', ''), description, content };
  }
  const raw = readFileSync(filePath, 'utf-8');
  const { description, content } = parseFrontmatter(raw);
  const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { name, slug, description, content };
}

export function saveCustomSkill(name: string, description: string, content: string): SkillSummary {
  const slug = slugify(name);
  const filePath = join(skillsDir, slug + '.md');
  const fileContent = description
    ? '---\ndescription: ' + description + '\n---\n\n' + content
    : content;
  writeFileSync(filePath, fileContent);
  return { name, slug, description };
}

export function deleteCustomSkill(slug: string): boolean {
  const filePath = join(skillsDir, slug + '.md');
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function getCustomSkillRaw(slug: string): { name: string; slug: string; description: string; content: string } | null {
  const filePath = join(skillsDir, slug + '.md');
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { description, content } = parseFrontmatter(raw);
  const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { name, slug, description, content };
}
