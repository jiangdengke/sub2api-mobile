#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const [, , jsonPath, platformArg, profileArg] = process.argv;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sanitize(value) {
  return String(value || '')
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getArtifactUrl(build) {
  return build?.artifacts?.buildUrl || build?.artifacts?.applicationArchiveUrl || '';
}

function getExtension(artifactUrl, platform) {
  try {
    const basename = path.basename(new URL(artifactUrl).pathname).toLowerCase();
    const match = basename.match(/\.([a-z0-9]+)$/);

    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fall back to platform defaults below.
  }

  if (platform === 'ios') {
    return 'ipa';
  }

  if (platform === 'android') {
    return 'apk';
  }

  return 'bin';
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${name}=${value}`);
    return;
  }

  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (!jsonPath) {
  fail('Usage: eas-artifact-metadata.js <eas-build.json> <platform> <profile>');
}

const platform = String(platformArg || '').toLowerCase();
const profile = sanitize(profileArg || 'release') || 'release';
const tag = sanitize(process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || 'untagged') || 'untagged';

let builds;

try {
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  builds = Array.isArray(parsed) ? parsed : [parsed];
} catch (error) {
  fail(`Failed to parse ${jsonPath}: ${error instanceof Error ? error.message : String(error)}`);
}

const build = builds.find((item) => String(item?.platform || '').toLowerCase() === platform) || builds[0];
const artifactUrl = getArtifactUrl(build);

if (!artifactUrl) {
  fail(`EAS build completed but no downloadable artifact URL was found for ${platform || 'unknown platform'}.`);
}

const detailsUrl = build?.buildDetailsPageUrl || build?.detailsPageUrl || build?.url || '';
const extension = getExtension(artifactUrl, platform);
const filename = `sub2api-mobile-${tag}-${platform || 'app'}-${profile}.${extension}`;
const artifactName = `sub2api-mobile-${platform || 'app'}-${profile}`;

setOutput('download_url', artifactUrl);
setOutput('details_url', detailsUrl);
setOutput('filename', filename);
setOutput('artifact_name', artifactName);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `### ${String(platform || 'app').toUpperCase()} EAS build`,
    '',
    `- Profile: ${profile}`,
    `- Release asset: ${filename}`,
  ];

  if (detailsUrl) {
    lines.push(`- EAS details: ${detailsUrl}`);
  }

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
}
