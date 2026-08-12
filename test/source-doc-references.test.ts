/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

/** Anything that reads as a repo-relative path to a markdown file, e.g. `docs/some-design.md`. */
const MARKDOWN_PATH = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.md/g;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

describe('source doc references', () => {
  /**
   * A comment that points at a design doc which was never committed is worse than no citation: the
   * reader cannot tell whether the doc is missing, moved, or internal-only. Cite something durable
   * (the work item) instead. Note that `docs/` is gitignored in this repo — it is where generated
   * typedoc output lands — so a design doc committed there would be invisible anyway.
   */
  it('cites no markdown file that is not committed in the repo', () => {
    const dangling = sourceFiles(srcRoot).flatMap((file) => {
      const citations = readFileSync(file, 'utf8').match(MARKDOWN_PATH) ?? [];
      return citations
        .filter((citation) => !existsSync(path.join(repoRoot, citation)))
        .map((citation) => `${path.relative(repoRoot, file)} cites missing ${citation}`);
    });

    expect(dangling).to.deep.equal([]);
  });
});
