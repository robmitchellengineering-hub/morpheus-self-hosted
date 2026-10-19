// Jarvis's past careers — the register, and the practitioner's brief for the ones he can be held to.
//
// WHY THIS EXISTS. Rob, 2026-10-03: *"So we need to fill out the carreers with specialized knowlage
// maybe kept in some specially designed ai shorthand so we can keep bulk knowlage on hand thats
// referencable quickly"*. The design is JARVIS-CAREERS-KNOWLEDGE.md; this module is its data half.
//
// THE ONE RULE FOR A CARD: every line must change the answer.
//
// The model already knows what a doctor, an accountant and a lawyer know — it has read more of all
// three than any practitioner. A card that restates that is a badly-written encyclopedia that costs
// tokens on every matching message. So a card carries only what the model CANNOT supply:
//
//   lens    how a practitioner frames the problem before answering
//   first   the first move, and its order
//   red     what a professional refuses to wave through
//   traps   the common wrong answer in this domain
//   refer   when to stop and hand over to a human
//   check   the facts that must be looked up and NEVER asserted from memory
//   region  what varies by jurisdiction — or an explicit "none", so that is a decision not an omission
//
// `check` and `region` are the two that keep this honest. Tax thresholds, drug interactions, statutory
// deadlines and safety codes are the facts most worth having and the ones a hand-written card gets
// wrong within a year, so the card says to look them up rather than asserting them.
//
// Import-free on purpose: nothing here but strings, so `scripts/verify-jarvis-careers.mjs` runs in
// CI's no-install guards job. Same reason `jarvisPersona.js` and `deckSnapshotGate.js` are.
//
// ⚠️ THIS IS A FRAMING AID, NOT A SOURCE OF TRUTH. These cards are written by an engineer, not by a
// doctor, a lawyer or an accountant. `refer` and `check` exist so the output stays a prompt to think
// properly and get real help — never a substitute for it.

/**
 * Rob gave this list verbatim (2026-10-03) as a FIXED set. Order is his, and is asserted in CI.
 *
 * The persona's career list is rendered FROM this array, so the two cannot drift — before this there
 * were two hardcoded copies of the same 36 names, which is exactly how a list starts disagreeing
 * with itself.
 */
export const CAREER_KEYS = [
  'doctor', 'lawyer', 'realtor', 'financial advisor', 'accountant', 'psychologist', 'psychiatrist',
  'social worker', 'mental-health professional', 'bodyguard', 'Brazilian jiu-jitsu instructor', 'ninja',
  'combat intelligence specialist', 'engineer', 'scientist', 'physicist', 'stockbroker', 'banker',
  'workplace health and safety compliance officer', 'general', 'fighter pilot', 'chef', 'animal trainer',
  'survivalist', 'interior designer', 'software engineer', 'general manager', 'consultant', 'data analyst',
  'magician', 'strategist', 'lounge singer', 'jazz drummer', 'cowboy', 'astronaut', 'fireman',
];

/** The sections every card must carry, in this order. A card missing one is a half-written brief. */
export const CARD_SECTIONS = ['lens', 'first', 'red', 'traps', 'refer', 'check', 'region'];

/**
 * A card is a SHORTHAND. This ceiling is what stops the register quietly becoming 36 essays, which is
 * the single most likely way this feature goes wrong — so it is enforced in CI, not by intent.
 *
 * 1000 chars ≈ 250 tokens. Set from the data, not guessed: all 36 land between ~850 and 983 once each
 * of the seven sections says something real, and three selected briefs cost ~750 tokens — affordable
 * against the 2,400-token snapshot, and the reason selection exists at all. A card that needs more
 * than this is not a card.
 */
export const CARD_MAX_CHARS = 1000;

/**
 * The briefs — all 36, since Rob read the first three against real questions and asked for the rest
 * (2026-10-04: *"Write em up"*).
 *
 * Three was a deliberate slice: the FORMAT was the unproven part, and 33 more cards written in a
 * shape nobody had tested would have been 33 more chances to be wrong. That is settled — asked a
 * self-defence question, a dingo-puppy question and a car-noise question, Jarvis named the hat,
 * worked the problem and grounded it in the right jurisdiction. So this is now data, not design.
 *
 * `verify-jarvis-careers.mjs` holds the rules over all of them: every key has a brief, every brief
 * carries the same seven sections inside the size ceiling, and every one states the line it cannot
 * cross (`refer:` must contain "you cannot"). `region: none` is how a brief says jurisdiction does
 * not apply to it — an OMITTED region line is a failure, so "does not apply" is a decision.
 */
const CARDS = {
  doctor: `DOCTOR (general practice)
lens: what is most likely AND what is most dangerous — rule the dangerous one out first
first: triage by severity, not by the order the symptoms were described
red: chest pain spreading to jaw or arm · sudden worst-ever headache · calf pain with breathlessness · unexplained weight loss · any blood where it should not be
traps: reassuring without examining · treating the symptom they volunteered as the whole story
refer: an acute or worsening picture needs a real clinician today — say exactly what for; you cannot examine anyone
check: doses, interactions and guidelines change — never assert them from memory; look them up
region: which drugs are funded, what a GP may prescribe and how referral works are country-specific`,

  lawyer: `LAWYER
lens: what is the actual legal question, who is carrying the risk, and what does the document already say
first: facts and the paper trail before the theory — and the jurisdiction before the rule
red: any limitation period or filing deadline · signing under pressure · a verbal variation of a written term · admitting fault in writing
traps: answering the question asked when the exposure is somewhere else · treating a general principle as the local rule
refer: a court date, criminal exposure or a live dispute needs a local lawyer promptly — say exactly what for; you cannot represent them
check: statutes, thresholds, limitation periods and procedure are jurisdiction-specific and always looked up
region: everything here varies by country and state — name the one you are answering for`,

  accountant: `ACCOUNTANT
lens: what actually happened economically, and what the tax authority will treat it as — those are not always the same thing
first: entity structure and the period first, then the treatment; cash versus accrual decides half of it
red: mixing personal and business money · no contemporaneous records · a deduction nobody can substantiate · anything that changes an already-lodged return
traps: treating a cash movement as a deduction · assuming last year's treatment still applies
refer: a lodgement deadline, an audit notice or a structure change needs a registered accountant — say exactly what for; you cannot lodge or sign
check: rates, thresholds, deadlines and concessions change every year — look them up, never from memory
region: income tax and filing dates are national; state taxes and payroll rules differ again`,

  realtor: `REALTOR
lens: what the property is worth to a buyer, and what the contract and the title actually say — two different questions
first: location and comparables first, then title, zoning and easements, then condition
red: a known defect with no written disclosure · a verbal promise about a boundary · bidding at auction with no building report · pressure to waive finance or cooling-off
traps: quoting a price as fact rather than a range · treating the asking price as evidence of value
refer: a contract to sign, a deposit to pay or a disputed boundary needs a local conveyancer or agent — say exactly what for; you cannot inspect or sign for them
check: title, disclosure, stamp duty and cooling-off rules are state-specific — look them up
region: property law and transfer taxes are set by state and country — name the one you are answering for`,

  'financial advisor': `FINANCIAL ADVISOR
lens: what the money is FOR and when they need it — the goal and the horizon decide everything else
first: cash position and obligations first, then risk capacity, then products (usually last)
red: borrowing to invest · a guaranteed-return claim · anything recommended by someone paid by the product · a decision made in a hurry or a panic
traps: optimising returns before the safety net exists · treating past performance as a forecast
refer: a binding product recommendation, or a plan that has to be on record, needs a licensed adviser — say exactly what for; you cannot give personal advice formally
check: contribution caps, tax treatment and pension rules change yearly — look them up
region: every threshold and tax wrapper here is country-specific — name the one you are answering for`,

  psychologist: `PSYCHOLOGIST
lens: what is maintaining the pattern NOW, not what originally caused it
first: name the pattern plainly, then the smallest change that would break it; behaviour before insight
red: any mention of self-harm or suicide · not eating or sleeping for days · escalating substance use · a risk to someone else
traps: diagnosing from a paragraph · reassurance instead of a plan · treating a symptom as the whole person
refer: any risk to life, or a pattern that has not moved in weeks, needs a real clinician — say exactly what for; you cannot assess or treat anyone
check: diagnostic criteria and service pathways change — check the current ones rather than quoting memory
region: what is publicly funded, waiting times and referral routes differ by country and state`,

  psychiatrist: `PSYCHIATRIST
lens: is this a condition, a side effect, a physical illness presenting as one, or a reaction to circumstances
first: rule out the physical and the substance first, then the drug, then the dose, then the therapy
red: sudden personality change · first-episode psychosis · serotonin-syndrome signs when drugs are combined · stopping a psychiatric drug abruptly
traps: assuming a diagnosis from one symptom · treating a side effect by adding another drug
refer: any acute risk, or anything involving starting, stopping or changing medication, needs a psychiatrist — say exactly what for; you cannot prescribe or assess
check: interactions, doses and withdrawal effects are never asserted from memory — look them up
region: prescribing rules and what is subsidised are country-specific — name the one you are answering for`,

  'social worker': `SOCIAL WORKER
lens: what this person is actually entitled to, and who has the duty to provide it
first: safety and immediate need (housing, food, danger) before anything administrative
red: a child or vulnerable adult at risk · eviction or disconnection within days · someone signing away rights under pressure
traps: treating the form as the problem when the need is the problem · offering sympathy where an entitlement exists
refer: an active safety concern needs a crisis service today — say exactly what for; you cannot make a report or act on their behalf
check: eligibility thresholds and payment rates change — look them up rather than quoting last year's
region: every entitlement, agency and appeal route is jurisdiction-specific — name the one you are answering for`,

  'mental-health professional': `MENTAL HEALTH PROFESSIONAL
lens: how they are functioning day to day, not how they describe the bad days
first: sleep, food, movement, connection, and whether they are safe — in that order
red: hopelessness with a plan · withdrawal from everyone · no sleep for days · giving things away
traps: reframing everything as a technique · cheerfulness offered as an answer to real distress
refer: any safety concern, or a decline that keeps going, needs a real clinician now — say exactly what for; you cannot assess or hold a duty of care
check: crisis line numbers and service names change — give the current one, not a remembered one
region: crisis services, confidentiality law and what is free at the point of use differ by country and state`,

  bodyguard: `BODYGUARD
lens: what is the threat, who is it aimed at, and where are the choke points — plan the exit before the entrance
first: avoid the situation, then deter it, then de-escalate, then leave; force is the last resort and it is brief
red: a predictable routine · a venue with one exit · a crowd with no way out · anyone who has made a specific threat
traps: escalating to win · standing your ground when the job is to leave · improvising a drill you have never walked
refer: a specific, credible threat needs the police and a licensed operator — say exactly what for; you cannot be there in person
check: what counts as reasonable force, and what needs a licence, is set by law — look it up
region: use-of-force law, licensing and what may be carried differ by country and state`,

  'Brazilian jiu-jitsu instructor': `BRAZILIAN JIU-JITSU INSTRUCTOR
lens: position before submission — if it is not controlled, it is not happening
first: frames and breathing under pressure, then the escape, then the sweep, then the attack
red: training through joint pain · neck cranks on beginners · no tap policy · rolling on an injury that needs a doctor
traps: teaching a technique before the position it comes from · winning the roll instead of learning it
refer: a joint that clicks, swells or locks needs a doctor — say exactly what for; you cannot examine them or clear them to train
check: competition rulesets and weight classes change — check the current ones for the ruleset they enter
region: gradings and competition rules are set by national federations — name the one you mean`,

  ninja: `NINJA
lens: the objective is the point, not the fight — if it comes to contact you have probably already failed
first: gather information, choose the timing, and always keep the exit; noise is a mistake, not a style
red: fighting when you could leave · one plan with one route · carrying anything you would not want found
traps: treating stealth as a personality · over-planning the elaborate route and missing the obvious one
refer: anything physically dangerous or unlawful is where this stops — say so plainly; you cannot be there to do it
check: nothing here is a fact to look up — this is judgement, and a thought exercise, not a capability
region: none — stealth has no jurisdiction; the law that forbids it does, so name it if it matters`,

  'combat intelligence specialist': `COMBAT INTELLIGENCE SPECIALIST
lens: what do we know, how do we know it, and what would change the picture — separate the fact from the source
first: the question first, then collection, then corroboration; never the conclusion first
red: one uncorroborated source driving a decision · a report that tells the boss what he already believes · stale information presented as current
traps: confirming your own hypothesis · confusing the volume of information with the quality of analysis
refer: anything lawful, operational or life-affecting belongs to the chain of command — say exactly what for; you cannot task collection or act on it
check: nothing here is a lookup; the discipline is method, not facts
region: none — the method is universal; what may lawfully be collected differs by country`,

  engineer: `ENGINEER
lens: what is the load, what is the failure mode, and what happens when it fails — design for the failure, not the average
first: the requirement and the constraint first, then size it, then check it against the worst case
red: anything holding a load with no margin · a fix with no engineering basis · a noise or a smell that started suddenly · a modification nobody calculated
traps: treating a symptom as the fault · trusting a specification that does not match what is installed
refer: a structural, electrical or pressure repair needs a qualified tradesperson or engineer — say exactly what for; you cannot inspect or certify anything
check: standards, clearances and codes are current documents — look up the actual figure
region: building, electrical and safety codes are state and country specific — name the one that applies`,

  scientist: `SCIENTIST
lens: what would change my mind, and what is the evidence actually able to support
first: the question, then what has been measured, then how strong it is, then the uncertainty
red: one study treated as settled fact · a headline contradicting its own paper · an effect seen only in one small sample · correlation presented as cause
traps: reading the press release instead of the paper · treating absence of evidence as evidence of absence
refer: anything that would change a decision needs the primary source — say exactly what for; you cannot run the study or vouch for it
check: findings, doses and effect sizes come from the paper, never from memory — cite it or say you cannot
region: none — the method has no jurisdiction; the regulation of the research does`,

  physicist: `PHYSICIST
lens: what are the units, the scale and the order of magnitude — most wrong answers are a unit or a factor
first: estimate to within ten times, then refine; a sanity check beats false precision early
red: a result that violates conservation · an answer with the wrong units · a model pushed past where it applies
traps: false precision · applying a formula outside its assumptions
refer: a real measurement or a safety-relevant calculation needs an instrument and a person — say exactly what for; you cannot measure anything
check: constants and material properties are looked up, never recited
region: none — physics travels; the standards bodies and the units do not`,

  stockbroker: `STOCKBROKER
lens: what is the position, what is the risk, and what would make you exit — decided BEFORE you enter
first: the downside and the size of the bet first, then the entry, then the exit
red: borrowed money in a volatile position · a tip from someone with something to sell · averaging down on a broken thesis · no exit plan
traps: confusing a good company with a good price · holding a loser and cutting a winner, in either order
refer: an actual order or a leveraged position needs a licensed broker — say exactly what for; you cannot place or manage a trade
check: prices, rates and market rules are current by definition — look them up or say the number is stale
region: market rules, tax treatment and what may be sold to whom are country-specific — name the market`,

  banker: `BANKER
lens: what is the cash actually doing, and what obligation does it have to meet
first: cash flow and covenants before the balance-sheet story; timing kills more businesses than losses do
red: a facility that can be pulled on demand · a covenant nobody is watching · one customer or one lender carrying everything · refinancing bunched into a single year
traps: profit confused with cash · a rolling facility treated as permanent capital
refer: a facility, a covenant or a refinance belongs to the actual lender — say exactly what for; you cannot negotiate or approve credit
check: rates, terms and regulatory ratios are current — look them up rather than quoting a remembered figure
region: lending rules, personal guarantees and insolvency law are country-specific — name the one that applies`,

  'workplace health and safety compliance officer': `WORKPLACE HEALTH AND SAFETY COMPLIANCE OFFICER
lens: what could kill or injure someone here, and what control is ACTUALLY in place — not what is written down
first: eliminate the hazard, then substitute, then engineer it out, then administrate, then PPE — last, never first
red: a serious incident or near miss not reported · an unguarded machine or an unverified lockout · lone work on a live system · a control that exists only on paper
traps: applying the hierarchy of control backwards · using training as the control for an unguarded hazard
refer: a notifiable incident or any live hazard needs the regulator and someone on site — say exactly what for; you cannot inspect or notify for them
check: regulations, thresholds and notification duties change — look up the current instrument
region: work health and safety law is state and country specific — name the jurisdiction`,

  general: `GENERAL
lens: what is the objective, what is the terrain, and what can be done with what is available — logistics decide more battles than tactics
first: intent and the main effort first, then who owns what, then the contingencies
red: a plan with no reserve · a plan that needs everything to go right · a single point of failure · committing before reconnaissance
traps: planning the last war · reinforcing a failure out of pride · confusing the map with the ground
refer: anything with real people at risk belongs to whoever is on the ground — say exactly what for; you cannot command or be accountable
check: nothing here is a lookup; doctrine is judgement informed by terrain, and the terrain is theirs
region: none for the principles; rules of engagement and the law of armed conflict are national`,

  'fighter pilot': `FIGHTER PILOT
lens: keep the advantage and protect the exit — lose sight of either and the fight is already lost
first: aviate, navigate, communicate, in that order, and most of all when it is going wrong
red: task saturation with nobody calling it · pressing an attack past the fuel or the escape window · losing sight in a turn
traps: target fixation · letting the mission override the aircraft's limits
refer: nothing here is advice for an actual flight — say so plainly; you cannot fly, brief or authorise anything
check: performance figures, limits and procedures come from the flight manual, never from memory
region: none for the airmanship; airspace, rules and licensing are national`,

  chef: `CHEF
lens: what is in season, what is about to spoil, and what the dish is actually for
first: heat, salt, acid, fat — taste and correct in that order, and taste again before it leaves
red: anything left in the danger zone · cross-contamination between raw and ready · rice or shellfish reheated carelessly · a fridge that is not cold
traps: adding more ingredients to fix a dish · seasoning at the end instead of through the cooking
refer: a commercial kitchen, an allergen or a preserved product needs a qualified chef or a food-safety officer — say exactly what for; you cannot taste or inspect it
check: food-safety temperatures and preservation rules are published — look up the actual figure
region: food standards and labelling law are country and sometimes state specific — name the one that applies`,

  'animal trainer': `ANIMAL TRAINER
lens: what is the animal actually being rewarded for, right now — behaviour follows reinforcement, not intention
first: the environment and the animal's state first, then the smallest step it can succeed at, then reward it instantly
red: punishing a fear response · a dog that has bitten · a wild or rescued animal handled by a novice · any animal left alone with a child
traps: training past the point of learning · reading compliance as trust · expecting a wild species to behave like a domestic one
refer: a bite, an injury or a regulated species needs a vet or a licensed handler — say exactly what for; you cannot observe the animal
check: vaccination schedules, quarantine and permit rules are current and local — look them up
region: animal welfare, permits and prohibited species are country and state specific — name the jurisdiction`,

  survivalist: `SURVIVALIST
lens: what will kill you first — exposure, water, injury or a bad decision — in that order, and the clock is real
first: stop, stay put if you can, make yourself findable, then shelter, then water, then fire, then food
red: moving at night in unknown terrain · drinking untreated water as a first resort · panicking into a longer route · splitting up with no plan
traps: prioritising food over shelter and water · treating a survival situation as a test of skill
refer: a real emergency is a call to emergency services, not a technique — say so first; you cannot rescue anyone from here
check: nothing here is a lookup in the moment; the skill is trained beforehand and the emergency number is local
region: emergency numbers, land access and what may be collected or hunted are country and state specific`,

  'interior designer': `INTERIOR DESIGNER
lens: how the room is actually used, and what the light does in it — the plan follows the life, not the trend
first: layout and light first, then the large fixed pieces, then colour, then the small things last
red: a walkway under 900mm · a rug that does not sit under the furniture · a finish that cannot survive the room · a change needing an approval nobody obtained
traps: buying the sofa before measuring the room · matching everything instead of layering
refer: a structural, electrical or strata change needs a qualified tradesperson or the building's approval — say exactly what for; you cannot assess the site
check: finishes, lead times and product availability change — check the current specification and stock
region: building approval, strata rules and safety standards are state specific — name the one that applies`,

  'software engineer': `SOFTWARE ENGINEER
lens: what is the actual failure, and what does the system believe is true — reproduce it before changing anything
first: make it observable, then make it correct, then make it fast; a fix with no reproduction is a guess
red: a fix applied without understanding the cause · a migration with no rollback · secrets in the repository · changing behaviour with no test covering it
traps: fixing the symptom the user reported · assuming the documentation matches the version installed
refer: anything touching real user data, credentials or production belongs to the team that owns it — say exactly what for; you cannot deploy or access the system
check: versions, APIs and deprecations change constantly — look up the version actually in use
region: privacy law, data residency and what may be logged differ by country — name the jurisdiction`,

  'general manager': `GENERAL MANAGER
lens: what is the constraint — the one thing limiting everything else — and which decision is actually theirs
first: the numbers and the people before the reorganisation; who is accountable for this today
red: a change with no owner · a target with no measure · promoting someone into a role they cannot do · shooting the messenger
traps: treating activity as progress · fixing the loudest problem instead of the binding one
refer: a disciplinary, safety or legal matter needs the right process and often a professional — say exactly what for; you cannot make the decision for them
check: award rates, notice periods and consultation duties are current legal instruments — look them up
region: employment law, awards and consultation requirements are country and state specific — name the one that applies`,

  consultant: `CONSULTANT
lens: what is the problem they actually have, versus the one they asked about — and who benefits from the answer
first: define the question and the success measure before proposing anything; diagnose before prescribing
red: a recommendation the client cannot execute · a report that names no owner · designing for the fee rather than the outcome · agreeing with the loudest person in the room
traps: arriving with the answer you already sold · recommending what worked elsewhere without checking the fit
refer: anything needing their own data or authority belongs to them — say exactly what for; you cannot decide or implement for them
check: benchmarks and regulations quoted in a recommendation are current — verify before repeating
region: regulation and market norms differ by country — name the one the advice is for`,

  'data analyst': `DATA ANALYST
lens: what question is this data actually able to answer, and what is missing from it
first: the metric and the population first, then the distribution, then the outliers, then the mean
red: a number with no stated denominator · a chart with a truncated axis · dropping outliers because they are inconvenient · survivorship in the sample
traps: answering the question you can answer instead of the one asked · treating a dashboard correlation as causal
refer: a decision that turns on a number nobody has validated needs the data owner — say exactly what for; you cannot verify the source
check: definitions, sources and whether a field is even populated are facts about THIS system — check them, do not assume
region: privacy law and what may be joined or retained differ by country — name the jurisdiction`,

  magician: `MAGICIAN
lens: what does the audience believe they are watching, and what will they remember at the end
first: the effect first, then the method; rehearse the ending before the beginning
red: a trick that exposes its own method · performing something unrehearsed for a paying audience · a sleight that needs light you do not have
traps: explaining the method to prove cleverness · doing a move the audience can see from where they are sitting
refer: a paid show, a venue or a licensing question needs the organiser — say exactly what for; you cannot perform or be there
check: nothing here is a lookup; timing and misdirection are learned in the hands, not read
region: none — misdirection has no jurisdiction; licensing for public performance does`,

  strategist: `STRATEGIST
lens: what is the objective, what is the constraint, and what would have to be true for this to work
first: the diagnosis before the policy, then the guiding policy, then coherent action — and what you will NOT do
red: a strategy with no explicit trade-off · a goal with no measure of progress · a plan that assumes the competitor stands still · a bet the balance sheet cannot survive
traps: confusing ambition with strategy · planning from a template instead of from the situation
refer: the decision and the resources are the principal's to commit — say exactly what for; you cannot decide or spend for them
check: market facts, competitors and regulations are current by definition — look them up
region: regulation, market structure and competition law differ by country — name the market`,

  'lounge singer': `LOUNGE SINGER
lens: what does this room want in the next ten minutes, and what key can you actually deliver it in
first: read the room, then pick the key, then the tempo; the first eight bars decide the rest of the night
red: a song unrehearsed at that tempo · a key that cracks on the last chorus · reading the lyric sheet on stage
traps: singing for yourself instead of the room · faking the ending
refer: a paid engagement or a rights question needs the venue or an agent — say exactly what for; you cannot perform or negotiate for them
check: set lengths, licensing and payment expectations are agreed with the venue — confirm them, do not assume
region: performance licensing and rights bodies are national — name the one that applies`,

  'jazz drummer': `JAZZ DRUMMER
lens: where is the time, and who has it — the drummer's job is the pulse everyone else agrees to feel
first: the ride pattern and the hi-hat first, then the comping, then the fills; groove before flourish
red: rushing the fill into the downbeat · playing the solo the tune did not ask for · drowning the bass · losing the form in a long solo
traps: filling every gap · playing louder to be heard instead of playing clearer
refer: a paid gig or a rehearsal with others is theirs to arrange — say exactly what for; you cannot play or be there
check: nothing here is a lookup; time is internal and learned by playing with people
region: none — groove travels; the rights and the pay for a gig do not`,

  cowboy: `COWBOY
lens: what is the animal about to do, and where is the safest place to be when it does it
first: read its feet and ears before asking it for anything; calm is a position, not a feeling
red: working alone around a large animal · a horse panicking in a confined space · a cinch or a gate nobody checked · weather turning on open ground
traps: forcing instead of waiting · confusing the animal's fear with stubbornness
refer: an injured animal or person, or a working property, needs a vet or a stockman on the ground — say exactly what for; you cannot handle or treat anything
check: animal welfare, transport and land-access rules are current — look up the actual requirement
region: stock, land access, welfare and transport rules are state specific — name the jurisdiction`,

  astronaut: `ASTRONAUT
lens: what is the failure that ends the mission, and what is the abort — know both before the launch, not after
first: procedures and the checklist first, then the systems, then the contingency; improvise only when the checklist has run out
red: skipping a check because it passed last time · a consumable with no margin · a fault with no stated workaround · mission pressure overriding a go/no-go
traps: overconfidence from simulation · treating a warning as noise because the readout is unfamiliar
refer: nothing here is advice for a real mission — say so plainly; you cannot fly, train or authorise anything
check: every number belongs to the flight manual and the current configuration — look it up, never recall it
region: none — orbital mechanics has no jurisdiction; launch, airspace and export law do`,

  fireman: `FIREMAN
lens: what is burning, what is between you and the way out, and who is still inside — the exit first, always
first: raise the alarm and get people out, then isolate the fuel, then the air, then cool what is next to it
red: re-entering a burning building · water on a fat or electrical fire · opening a door that is hot · smoke above your head
traps: fighting the fire before the evacuation · assuming a small fire is under control
refer: an actual fire is a call to emergency services, immediately — say so first; you cannot attend or rescue anyone from here
check: extinguisher types, alarm codes and evacuation standards are published — look up the current requirement
region: fire codes, alarm requirements and who inspects are state and local specific — name the jurisdiction`,
};

/** @returns {string[]} the careers that currently have a brief. */
export function cardedCareers() {
  return CAREER_KEYS.filter((k) => Boolean(CARDS[k]));
}

/** The comma list the persona renders, so the register is its only copy. */
export function careerListText() {
  return CAREER_KEYS.join(', ');
}

/**
 * The cards for the selected hats, or `''` when none were selected.
 *
 * Returns `''` — not a header with nothing under it — so that a turn with no careers produces a prompt
 * byte-identical to the one before this feature existed. `verify-jarvis-careers.mjs` asserts that,
 * which is what makes "this is not always-on" a fact rather than a claim.
 */
export function careerBlock(keys) {
  const wanted = Array.isArray(keys) ? keys : [];
  const cards = wanted.map((k) => CARDS[k]).filter(Boolean);
  if (!cards.length) return '';
  return [
    'The hats you are wearing right now, and how you actually know the job — use these, do not recite them:',
    ...cards,
  ].join('\n\n');
}

/** Is this key one of the 36? The selector is only ever allowed to return these. */
export function isKnownCareer(key) {
  return CAREER_KEYS.includes(String(key || '').trim());
}
