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

const limit = 100;
let skip = 0, total = Infinity, slugs = [];

while(skip < total){
  const res = await fetch('https://leetcode.com/graphql/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `LEETCODE_SESSION=${session}; csrftoken=${csrf}`,
      'x-csrftoken': csrf,
      'Referer': 'https://leetcode.com',
    },
    body: JSON.stringify({ query, variables: { categorySlug: '', skip, limit, filters: { status: 'AC' } } })
  });
  if(!res.ok){
    console.error('LeetCode request failed:', res.status, await res.text());
    process.exit(1);
  }
  const json = await res.json();
  const data = json.data && json.data.problemsetQuestionList;
  if(!data){
    console.error('Unexpected response shape — your session cookie has probably expired. Refresh the LEETCODE_SESSION secret.');
    process.exit(1);
  }
  total = data.total;
  slugs.push(...data.questions.map(q => q.titleSlug));
  skip += limit;
}

mkdirSync('data', { recursive: true });
writeFileSync('data/solved.json', JSON.stringify({ updatedAt: new Date().toISOString(), slugs }, null, 2));
console.log(`Wrote ${slugs.length} solved slugs to data/solved.json`);
