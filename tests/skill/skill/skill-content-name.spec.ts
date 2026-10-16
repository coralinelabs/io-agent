import { describe, expect, it } from 'vitest'
import { renderSkillContent, skillContentName } from "../../../src/library/skills/skill/index.ts"

describe('skillContentName', () => {
  it('recovers the name written by renderSkillContent, including escaped characters', () => {
    for (const name of ['demo', 'multi-part-name', 'odd "quoted" <name> & more']) {
      expect(skillContentName(renderSkillContent({ name, provider: 'filesystem', content: 'Body.' }))).toBe(name)
    }
  })
  it('matches only a loaded skill body, never other skill tool output', () => {
    for (const text of ['Skill "demo" is unchanged.', 'Forked skill "demo" finished.', '', ' <skill_content name="demo">', '<skill_content name="">']) {
      expect(skillContentName(text)).toBeUndefined()
    }
  })
})
