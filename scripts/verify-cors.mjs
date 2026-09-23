import { readFileSync } from 'node:fs';
// Runtime verification for CORS origin resolution.
//
// Run: node scripts/verify-cors.mjs
//
// The property that matters most is the last one: this API must never tell a
// browser it may reflect an arbitrary origin AND send credentials. The previous
// implementation did exactly that whenever CORS_ORIGIN was unset.

import { resolveCors, safeReturnUrl, DEFAULT_CORS_ORIGIN } from '../server/src/lib/corsOrigin.js'

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

// ── where Stripe may send a buyer back to ───────────────────────────────────
// createTokenCheckout used to hand the client's successUrl/cancelUrl to Stripe
// verbatim, so the post-payment redirect was caller-controlled. The price was
// never at risk (the block is looked up server-side by index), but an open
// redirect on a payment flow is a real finding, and it stops being theoretical
// once a widget token can buy credits. Asserted as behaviour, not as source.
console.log('\nWhere Stripe may send a buyer back to')
const APP = 'https://morpheus.nz'
check('the buyer may return to the page they were on, same origin',
  safeReturnUrl(`${APP}/workspace?tab=seo`, '/?credits=success', APP), `${APP}/workspace?tab=seo`)
check('a FOREIGN origin is not used', safeReturnUrl('https://evil.example/steal', '/?credits=success', APP), `${APP}/?credits=success`)
check('…not even as a prefix or a lookalike', safeReturnUrl('https://morpheus.nz.evil.example/x', '/?credits=success', APP), `${APP}/?credits=success`)
check('…and a SUBDOMAIN is a different origin', safeReturnUrl('https://evil.morpheus.nz/x', '/?credits=success', APP), `${APP}/?credits=success`)
check('a javascript: URL is refused', safeReturnUrl('javascript:alert(1)', '/?credits=success', APP), `${APP}/?credits=success`)
check('a protocol-relative URL is refused', safeReturnUrl('//evil.example/x', '/?credits=success', APP), `${APP}/?credits=success`)
check('nothing at all still lands somewhere real', safeReturnUrl(undefined, '/?credits=success', APP), `${APP}/?credits=success`)
check('garbage still lands somewhere real', safeReturnUrl('not a url', '/?credits=cancelled', APP), `${APP}/?credits=cancelled`)
check('and with no usable base the documented dev default is used',
  safeReturnUrl('https://evil.example/', '/?credits=success', undefined), `${DEFAULT_CORS_ORIGIN}/?credits=success`)

// The call site has to actually use it, or the rule never runs.
const checkoutSrc = readFileSync(new URL('../server/src/functions/createTokenCheckout.js', import.meta.url), 'utf8')
check('checkout validates the return URL rather than trusting it',
  /safeReturnUrl\(successUrl/.test(checkoutSrc) && /safeReturnUrl\(cancelUrl/.test(checkoutSrc), true)
check('…and the raw client values never reach Stripe',
  /success_url: successUrl|success_url: \b(successUrl)\b/.test(checkoutSrc), false)

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) { console.log(`${fail} FAILED\n`); process.exit(1) }
console.log('all good\n')
