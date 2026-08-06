/**
 * What `baton push` refuses to publish.
 *
 * §7.4: a task scoped to CI configuration, an agent that edits it, and a push
 * together are remote code execution on the CI runner — the agent writes the
 * workflow, the push runs it, with whatever secrets that runner holds. The
 * guard is on by default for every caller, because `baton push` is a CLI
 * command and agents run CLI commands.
 *
 * The pattern list is the guard, so it is tested directly rather than through a
 * repository: a path that should match and does not is the entire failure.
 */
import { describe, expect, it } from 'vitest';
import { ciPaths } from '../src/commands/push.js';

describe('ciPaths — what counts as handing code to a runner', () => {
  it('catches the workflow directory, which is the actual attack', () => {
    expect(ciPaths(['.github/workflows/release.yml'])).toEqual(['.github/workflows/release.yml']);
    expect(ciPaths(['.github/actions/deploy/action.yml'])).toEqual(['.github/actions/deploy/action.yml']);
  });

  it('covers the other runners people actually use', () => {
    const files = [
      '.gitlab-ci.yml',
      '.circleci/config.yml',
      'Jenkinsfile',
      'azure-pipelines.yml',
      'bitbucket-pipelines.yml',
      '.drone.yml',
      '.travis.yml',
      '.buildkite/pipeline.yml',
    ];
    // Every one of them, or the guard is a false sense of security for whoever
    // is not on GitHub Actions.
    expect(ciPaths(files).sort()).toEqual([...files].sort());
  });

  it('accepts .yaml as well as .yml', () => {
    expect(ciPaths(['azure-pipelines.yaml'])).toEqual(['azure-pipelines.yaml']);
  });

  it('leaves ordinary source alone', () => {
    // A guard that fires on normal work gets disabled, and then protects nothing.
    expect(ciPaths(['src/index.ts', 'README.md', 'package.json', 'docs/ci.md'])).toEqual([]);
  });

  it('does not match a lookalike path outside the repo root', () => {
    // `vendor/.travis.yml` belongs to a vendored dependency and runs nothing here;
    // the patterns are anchored so it cannot be used to trip the guard either.
    expect(ciPaths(['vendor/.travis.yml', 'docs/.github/workflows/x.yml'])).toEqual([]);
  });

  it('reports every offending path, not just the first', () => {
    // The message is a list a person has to review; stopping at one would hide
    // the rest of what they are about to publish.
    expect(ciPaths(['.github/workflows/a.yml', 'src/x.ts', '.github/workflows/b.yml']))
      .toEqual(['.github/workflows/a.yml', '.github/workflows/b.yml']);
  });
});
