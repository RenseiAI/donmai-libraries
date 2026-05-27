/**
 * Template Loader
 *
 * Discovers, parses, and validates workflow templates from YAML files.
 * Supports layered resolution:
 *   1. Built-in defaults (packages/core/src/templates/defaults/)
 *   2. Project-level overrides (.donmai/templates/ in repo root)
 *   3. Inline config overrides (programmatic)
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { WorkflowTemplate, PartialTemplate } from './types.js'
import { validateWorkflowTemplate, validatePartialTemplate } from './types.js'

/**
 * Load all workflow templates from a directory.
 * Only processes .yaml and .yml files at the top level.
 *
 * The map key is determined by `metadata.name` when it differs from `metadata.workType`,
 * enabling strategy-specific compound keys like "refinement-context-enriched".
 * When `metadata.name` equals `metadata.workType`, the key is simply the work type.
 */
export function loadTemplatesFromDir(dir: string): Map<string, WorkflowTemplate> {
  const templates = new Map<string, WorkflowTemplate>()

  if (!fs.existsSync(dir)) {
    return templates
  }

  const files = fs.readdirSync(dir).filter(f =>
    (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_')
  )

  for (const file of files) {
    const filePath = path.join(dir, file)
    const template = loadTemplateFile(filePath)
    if (template) {
      // Use metadata.name as the key when it differs from workType (strategy templates),
      // otherwise fall back to workType for backward compatibility.
      const key = template.metadata.name !== template.metadata.workType
        ? template.metadata.name
        : template.metadata.workType
      templates.set(key, template)
    }
  }

  return templates
}

/**
 * Load and validate a single workflow template YAML file.
 */
export function loadTemplateFile(filePath: string): WorkflowTemplate | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const data = parseYaml(content)
    return validateWorkflowTemplate(data, filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load template ${filePath}: ${message}`)
  }
}

/**
 * Load all partial templates from a directory (including subdirectories).
 * Returns a map of partial name → content string.
 *
 * Partial names are derived from file paths relative to the partials directory:
 *   partials/cli-instructions.yaml → "cli-instructions"
 *   partials/frontend/linear-cli.yaml → "frontend/linear-cli"
 */
export function loadPartialsFromDir(
  dir: string,
  frontend?: string
): Map<string, string> {
  const partials = new Map<string, string>()

  if (!fs.existsSync(dir)) {
    return partials
  }

  loadPartialsRecursive(dir, dir, partials, frontend)
  return partials
}

function loadPartialsRecursive(
  baseDir: string,
  currentDir: string,
  partials: Map<string, string>,
  frontend?: string
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name)

    if (entry.isDirectory()) {
      loadPartialsRecursive(baseDir, fullPath, partials, frontend)
      continue
    }

    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) {
      continue
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      const data = parseYaml(content)
      const partial = validatePartialTemplate(data, fullPath)

      // Skip frontend-specific partials that don't match the current frontend
      if (partial.metadata.frontend && frontend && partial.metadata.frontend !== frontend) {
        continue
      }

      // Derive partial name from relative path (without extension)
      const relativePath = path.relative(baseDir, fullPath)
      const name = relativePath.replace(/\.(yaml|yml)$/, '').replace(/\\/g, '/')

      partials.set(name, partial.content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to load partial ${fullPath}: ${message}`)
    }
  }
}

/**
 * Get the path to the built-in default templates directory.
 */
export function getBuiltinDefaultsDir(): string {
  // Resolve relative to this file's location
  return path.join(path.dirname(new URL(import.meta.url).pathname), 'defaults')
}

/**
 * Get the path to the built-in default partials directory.
 */
export function getBuiltinPartialsDir(): string {
  return path.join(getBuiltinDefaultsDir(), 'partials')
}
