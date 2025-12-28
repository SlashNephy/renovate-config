import { RequestError } from '@octokit/request-error'
import { Octokit } from '@octokit/rest'
import { z } from 'zod'

import renovateConfig from '../renovate.json' with { type: 'json' }

const envSchema = z.object({
  GITHUB_TOKEN: z.string(),
  GITHUB_USER: z.string().optional(),
  GITHUB_ORG: z.string().optional(),
  DRY_RUN: z.stringbool().default(true),
})

const env = await envSchema.parseAsync(process.env)

const octokit = new Octokit({
  auth: env.GITHUB_TOKEN,
})

async function listUserRepos(username: string): Promise<[string, string][]> {
  const repos = await octokit.paginate(octokit.repos.listForUser, {
    username,
    per_page: 100,
  })

  return repos
    .filter((repo) => repo.archived === false && !repo.fork)
    // eslint-disable-next-line @susisu/safe-typescript/no-type-assertion
    .map((repo) => repo.full_name.split('/') as [string, string])
}

async function listOrgRepos(org: string): Promise<[string, string][]> {
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org,
    per_page: 100,
  })

  return repos
    .filter((repo) => repo.archived === false && !repo.fork)
    // eslint-disable-next-line @susisu/safe-typescript/no-type-assertion
    .map((repo) => repo.full_name.split('/') as [string, string])
}

const repos = await Promise.all([
  env.GITHUB_USER ? listUserRepos(env.GITHUB_USER) : Promise.resolve([]),
  env.GITHUB_ORG ? listOrgRepos(env.GITHUB_ORG) : Promise.resolve([]),
]).then((lists) => lists.flat())
const promises = repos.map(async ([owner, repo]) => {
  let sha: string | undefined
  try {
    const content = await octokit.repos.getContent({
      owner,
      repo,
      path: 'renovate.json',
    })

    // eslint-disable-next-line @susisu/safe-typescript/no-unsafe-object-property-check
    if ('sha' in content.data) {
      sha = content.data.sha
    }

    // eslint-disable-next-line @susisu/safe-typescript/no-unsafe-object-property-check
    if ('content' in content.data) {
      const json = Buffer.from(content.data.content, 'base64').toString()
      const repoRenovateConfig = JSON.parse(json)

      if (
        renovateConfig.$schema === repoRenovateConfig.$schema
        && renovateConfig.extends[0] === repoRenovateConfig.extends[0]
      ) {
        return
      }
    }
  } catch (error: unknown) {
    if (!(error instanceof RequestError) || error.status !== 404) {
      console.error(`[${owner}/${repo}] Error while getting content`, error)

      return
    }
  }

  try {
    if (!env.DRY_RUN) {
      // @ts-expect-error sha can be undefined
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: 'renovate.json',
        message: 'chore(renovate): update config',
        content: Buffer.from(JSON.stringify(renovateConfig, null, 2)).toString('base64'),
        sha,
      })
    }

    console.info(`${owner}/${repo} update done.`)
  } catch (error: unknown) {
    console.error(`[${owner}/${repo}] Failed to update`, error)
  }
})

await Promise.all(promises)
