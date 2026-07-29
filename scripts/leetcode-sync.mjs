// scripts/leetcode-sync.mjs
// Runs inside your own GitHub Actions workflow. Reads your LeetCode session
// cookie from an Actions secret (never logged, never leaves this run), pulls
// your full solved list, and writes it to data/solved.json for the tracker
// to read over raw.githubusercontent.com.

import { writeFileSync, mkdirSync } from 'node:fs';

const session = process.env.LEETCODE_SESSION;
const csrf = process.env.LEETCODE_CSRF_TOKEN || '';

if(!session){
  console.error('Missing LEETCODE_SESSION secret — add it under Settings > Secrets and variables > Actions.');
  process.exit(1);
}

const query = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
    total: totalNum
    questions: data { titleSlug status }
  }
}`;

// IMPORTANT: we deliberately do NOT ask LeetCode's API to filter server-side
// via filters:{status:'AC'} — that filter shape isn't reliably honored by
// the current schema and silently matches zero questions, which is why this
// used to write an empty slugs array with no error. Instead we page through
// every problem (filters:{}) and check each question's own `status` field,
// which LeetCode sets to the string "ac" once you've solved it, "notac" if
// you've attempted but not solved it, or null if untouched.
const limit = 100;
let skip = 0, total = Infinity, slugs = [], sawAnyStatus = false;

while(skip < total){
  const res = await fetch('https://leetcode.com/graphql/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `LEETCODE_SESSION=${session}; csrftoken=${csrf}`,
      'x-csrftoken': csrf,
      'Referer': 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (compatible; dsa-tracker-sync/1.0)',
    },
    body: JSON.stringify({ query, variables: { categorySlug: '', skip, limit, filters: {} } })
  });
  if(!res.ok){
    console.error('LeetCode request failed:', res.status, await res.text());
    process.exit(1);
  }
  const json = await res.json();
  if(json.errors){
    console.error('LeetCode GraphQL returned errors:', JSON.stringify(json.errors));
    process.exit(1);
  }
  const data = json.data && json.data.problemsetQuestionList;
  if(!data){
    console.error('Unexpected response shape — your session cookie has probably expired. Refresh the LEETCODE_SESSION secret.');
    process.exit(1);
  }
  total = data.total;
  for(const q of data.questions){
    if(q.status) sawAnyStatus = true; // any non-null status means the cookie is authenticated
    if(q.status === 'ac') slugs.push(q.titleSlug);
  }
  skip += limit;
}

if(!sawAnyStatus){
  console.error(
    'Every question came back with status:null, which means LeetCode did not recognize this run as ' +
    'logged in — your LEETCODE_SESSION / LEETCODE_CSRF_TOKEN secrets are likely stale. Open leetcode.com ' +
    'in a browser you are logged into, copy fresh values for the LEETCODE_SESSION and csrftoken cookies ' +
    '(DevTools > Application > Cookies), update the repo secrets under Settings > Secrets and variables > ' +
    'Actions, and re-run the workflow.'
  );
  process.exit(1);
}

mkdirSync('data', { recursive: true });
writeFileSync('data/solved.json', JSON.stringify({ updatedAt: new Date().toISOString(), slugs }, null, 2));
console.log(`Wrote ${slugs.length} solved slugs to data/solved.json (out of ${total} total problems seen)`);
