// Runtime verification for CORS origin resolution.
//
// Run: node scripts/verify-cors.mjs
//
// The property that matters most is the last one: this API must never tell a
// browser it may reflect an arbitrary origin AND send credentials. The previous
// implementation did exactly that whenever CORS_ORIGIN was unset.

import { resolveCors, DEFAULT_CORS_ORIGIN } from '../server/src/lib/corsOrigin.js'

let pass = 0, fail = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`)
  ok ? pass++ : fail++
}

console.log('\nCORS origin resolution\n')

console.log('1. unset — must fail CLOSED, not open')
const unset = resolveCors(undefined)
check('falls back to the dev frontend', unset.origins, [DEFAULT_CORS_ORIGIN])
check('is not a wildcard', unset.wildcard, false)
check('credentials allowed (explicit origin, so safe)', unset.credentials, true)
check('origin is the allowlist, not `true`', unset.origin, [DEFAULT_CORS_ORIGIN])

console.log('\n2. empty / whitespace-only — same as unset')
check('empty string', resolveCors('').origins, [DEFAULT_CORS_ORIGIN])
check('whitespace', resolveCors('   ').origins, [DEFAULT_CORS_ORIGIN])

console.log('\n3. a real single origin')
const one = resolveCors('https://morpheus.nz')
check('used as-is', one.origin, ['https://morpheus.nz'])
check('credentials allowed', one.credentials, true)
check('not a wildcard', one.wildcard, false)

console.log('\n4. a real allowlist')
const many = resolveCors('https://morpheus.nz, https://app.morpheus.nz')
check('split and trimmed', many.origins, ['https://morpheus.nz', 'https://app.morpheus.nz'])
check('credentials allowed', many.credentials, true)

console.log('\n5. wildcard — the dangerous case')
const star = resolveCors('*')
check('is flagged as a wildcard', star.wildcard, true)
check('reflects the requesting origin', star.origin, true)
check('CREDENTIALS DISABLED alongside it', star.credentials, false)

console.log('\n6. wildcard mixed with real origins — still the dangerous case')
const mixed = resolveCors('https://morpheus.nz,*')
check('wildcard wins', mixed.wildcard, true)
check('CREDENTIALS DISABLED alongside it', mixed.credentials, false)

console.log('\n7. THE PROPERTY — never wildcard AND credentials, for any input')
const inputs = [undefined, null, '', '   ', '*', '*,*', '*,https://a.test', 'https://a.test,*', 'http://localhost:5173']
let violations = []
for (const i of inputs) {
  const r = resolveCors(i)
  if (r.wildcard && r.credentials) violations.push(String(i))
}
check('no input produces wildcard + credentials', violations, [])

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) { console.log(`${fail} FAILED\n`); process.exit(1) }
console.log('all good\n')
