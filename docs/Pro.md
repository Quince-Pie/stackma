## Conclusion

For **automatically generated, non-secret English names**—for projects, devices, sessions, workspaces, or software resources—the strongest starting design I would build is:

> **A familiar adjective + a familiar, concrete singular noun, forming an easily understood phrase, selected to be distinct from the other names that the user encounters.**

For example: `mossy-lantern`, `sleepy-otter`, or `silver-cactus`. These illustrate the design; they are not experimentally ranked winners.

The most important improvement over a basic adjective–noun generator is **not a cleverer adjective list**. It is treating the generator as a system for helping people distinguish and retrieve identities:

**Curate words → curate combinations → prevent locally confusing assignments → measure correct human use.**

The research does **not** establish that maximum weirdness, mandatory alliteration, or a particular syllable count produces universally superior names. It does provide useful evidence about familiarity, phrase memory, imagery, similarity, and interference. Below, I separate those findings from the engineering decisions I recommend.

---

## 1. Define “perfect” in terms of what people must do

Consider these tasks:

| Human task                                    | What the design should optimize                                        |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Remember a name tomorrow                      | Exact delayed recall, including both words                             |
| Find the correct resource in a list           | Recognition and discrimination from nearby alternatives                |
| Tell another person the name                  | Pronunciation, auditory discrimination, and spelling recovery          |
| Type it into a command or search box          | Entry time, spelling errors, and safe error handling                   |
| Remember which name belongs to which resource | Correct **name–entity association**, not merely remembering the phrase |

These are different optimization targets. In particular, experimental work has found different word-frequency effects for recognizing individual words versus remembering associations between words. A vocabulary choice that helps one memory task need not help another. ([Springer][1])

For a software label, I would define success as:

> **The user identifies the intended entity, after the relevant delay, with low effort and a low probability of selecting the wrong entity.**

Remembering `sleepy-otter` perfectly but assigning it to the wrong project is a failure.

That definition also changes the priorities. For a disposable demo session, pleasantness may matter considerably. For selecting a deployment target, confusing two names can matter much more than whether either name is charming.

### Why “words are memorable” is insufficient

In a **1,476-participant study**, Shay and colleagues compared system-assigned three- and four-word passphrases with other system-assigned passwords of similar entropy. The tested passphrases were forgotten at similar rates, took longer to enter, and did not deliver the expected general usability advantage. Most participants stored their assigned secrets rather than relying solely on memory. This is not a direct test of two-word resource names, but it is a strong warning against assuming that dictionary words automatically solve usability. ([CUPS][2])

Conversely, the **MASCARA** research reported benefits for a more deliberately constrained passphrase generator in some recall comparisons. Its study involved longer phrases, selection from alternatives, and practice, so it does not establish the optimal two-word naming template either. Together, these findings favor evaluating the complete generation-and-use process rather than declaring a format intrinsically memorable. ([CS Wisc][3])

---

## 2. What the memory evidence actually supports

### 2.1 Familiar combinations deserve more credit than naming folklore gives them

One of the most directly relevant studies is **Jacobs, Dell, and Bannard’s 2017 research on adjective–noun phrase recall**.

Across three experiments, frequent phrases had a recall advantage: participants were more likely to recover both component words from frequently encountered phrases than from less frequent phrases. The authors interpreted this as existing phrase knowledge helping reconstruct the studied sequence. ([researchconnect.buffalo.edu][4])

**Design implication:** Do not automatically penalize a combination because it sounds ordinary.

There are three different properties:

* **Familiar words:** the person knows the components.
* **Familiar combination:** the person has encountered the words together.
* **Distinct assignment:** the name is distinguishable from the other names in the current application.

Those properties should be assessed separately. A phrase can be familiar linguistically and still distinguish a resource perfectly well.

This also means that a generator should not blindly maximize semantic distance between its adjective and noun. Making the components unrelated may remove useful existing associations without providing a compensating benefit.

### 2.2 Concrete nouns and coherent imagery are useful—but imagery must connect the words

In a classic experiment, Bower and Winzenz compared ways of learning noun pairs. Imagining the referents interacting produced better associative memory than rote repetition; generating a meaningful sentence also outperformed merely repeating the pair. Importantly, participants were instructed to use these strategies. This does not prove that displaying any imageable phrase automatically produces the same benefit. ([Springer][5])

My design inference is to favor names that admit a **simple, integrated interpretation**.

For `mossy-lantern`, the adjective changes the imagined lantern. The two parts can be represented together. By contrast, a combination such as `optimal-concept` supplies little concrete structure to that interpretation.

The relevant question is not simply:

> “Are these two words individually imageable?”

It is:

> **“Can someone readily understand what the adjective contributes to this particular noun?”**

Large published concreteness norms are available: Brysbaert, Warriner, and Kuperman collected ratings for **37,058 words and 2,896 two-word expressions**. These are useful for screening candidate nouns, but concreteness ratings are not measurements of a generated name’s memorability. ([Springer][6])

### 2.3 “More bizarre” is not a reliable optimization rule

Bizarreness can improve memory under some experimental conditions, but the effect depends on the task and surrounding material. For example, Burns found that a bizarre-imagery advantage depended on study instructions; the paper also discusses restrictions involving mixed lists and free recall. ([Springer][7])

Therefore, I would **not** give an automatic bonus to the strangest candidate.

A sensible candidate policy is:

> Allow unusual but immediately interpretable combinations; reject combinations whose novelty comes mainly from obscurity or interpretive difficulty.

That is a hypothesis for testing, not a proven “optimal level of weirdness.”

There is also a logical distinction between being unusual relative to everyday language and being distinctive within a product. A generator that produces uniformly surreal names cannot assume that every output gains the advantage of being the unusual item among ordinary ones.

### 2.4 Alliteration can help, but should not be mandatory

There is positive evidence for alliteration. In a study of **54 English-language learners**, Boers, Lindstromberg, and Webb found stronger memory traces for alliterative expressions, particularly their form. However, the expressions were idioms embedded repeatedly in reading material—not arbitrary resource labels seen once. ([Sage Journals][8])

There is also evidence that phonologically similar material can interfere with memory. Roodenrys and colleagues demonstrated that phonological similarity can impair recall of the items themselves, not only their order, in serial-recall tasks. ([British Psychological Society][9])

These results do not contradict one another. **Sound structure within one phrase** and **sound similarity between competing names** are different questions.

My recommendation is to allow alliteration, but not require it. Compare alliterative and non-alliterative variants experimentally while controlling familiarity, length, and other properties. Never sacrifice a clear, familiar word merely to achieve a matching initial sound.

Mandatory alliteration also removes combinations from the available name space. That is an engineering cost even before considering memory.

### 2.5 Familiarity is more useful than shortest-possible spelling

I would favor a familiar, readily spelled word over a shorter but obscure one.

EFF’s word-list design provides a useful engineering precedent: it prioritized familiarity, then concreteness, and filtered difficult spellings, homophones, and problematic vocabulary. The resulting long-list words were longer on average than those in the original Diceware list. EFF explicitly described its choices as needing further usability evaluation, rather than presenting them as a proven memory optimum. ([Electronic Frontier Foundation][10])

Age of acquisition is another useful screening variable. Kuperman and colleagues’ ratings for more than 30,000 English content words predicted word-recognition performance beyond frequency, length, and similarity. However, these population-level ratings should not be treated as a guarantee that a particular international audience knows a word. ([Springer][11])

**Practical consequence:** Do not expand a name space by filling it with obscure animals, archaic adjectives, or unfamiliar proper names before considering another naming structure.

---

## 3. The linguistic structure I recommend

### Use adjective–noun as the default, but do not claim it is a universal memory winner

For an ordinary English descriptive label, adjective–noun gives a clear intended structure:

```text
[property or state] + [thing]
```

I would prefer adjectives describing an easily understood property or state: appearance, texture, size, material-like appearance, motion, or a recognizable condition.

The adjective list must contain words that actually work **before nouns**. Merely tagging a word “adjective” is insufficient. English distinguishes adjectives such as `sleepy`, which readily occur before nouns, from words such as `asleep`, which strongly resist that position in ordinary usage. Experimental and distributional research on these “a-adjectives” documents this distinction. ([Psychology of Language Lab][12])

Thus, `sleepy-otter` is a better default grammatical candidate than `asleep-otter`.

A scientifically important caveat: **natural English ordering is not proof of best recall**. Paivio’s adjective–noun paired-associate research found an advantage for noun-first ordering in its learning task. That task is not equivalent to using a conventional resource label, but it prevents a blanket claim that adjective-first order is inherently superior for memory. ([ResearchGate][13])

My choice of adjective–noun is therefore a combination of linguistic regularity, interpretability, and implementation simplicity—not a claimed universal experimental victory.

### Prefer singular, concrete head nouns

For the initial design, I would use singular nouns referring to recognizable objects, organisms, places, or phenomena.

This gives a consistent representation: one modified thing. It also avoids adding plural formation as another variable the user must reproduce.

I would not require every word to have only one possible grammatical category. Many useful English words have multiple uses. Instead, I would require that the **specific combination has an obvious intended reading**.

### Do not assume noun–noun is worse

A noun–noun design, such as `rabbit-lantern`, is a legitimate competitor. It can be interpreted as a lantern shaped like a rabbit, decorated with rabbits, or related to rabbits in another way. Those possibilities illustrate why its intended relationship may need more interpretation than a straightforward property adjective.

That is a reason to test it, not enough evidence to reject it. In a rigorous comparison, noun–noun should remain a candidate where its vocabulary or imagery is especially good.

### When adding a third word, use typed slots

I would avoid selecting two arbitrary adjectives independently.

Instead, test a structured template such as:

```text
[size]-[color or material-like property]-[noun]
```

For example, `small-silver-otter`.

English adjective ordering has systematic preferences, with experimental work showing a substantial role for adjective subjectivity. It is not simply a free permutation of modifiers. ([Alps Lab][14])

Adding a third word should solve an actual capacity or discrimination problem. It should not be justified by “more words must make a richer memory.”

### The hyphen is an engineering choice, not a mnemonic discovery

For a software-facing canonical representation, I recommend:

```text
lowercase-adjective-lowercase-noun
```

More precisely: lowercase ASCII letters, with the ordinary hyphen-minus character `-` between words, and no punctuation inside either token.

This makes the representation easy to specify and validate. It preserves an explicit word boundary without relying on capitalization.

I would not claim that hyphens have been shown to outperform spaces or other separators for remembering these names. Keep the canonical representation consistent, and test copying, selection, screen-reader output, and search behavior in the actual interface.

---

## 4. Optimize the set of names, not just each name

This is the part I would prioritize most strongly in implementation.

Compare two hypothetical workspaces:

```text
sleepy-otter
sleepy-beaver
sleepy-badger
```

and:

```text
sleepy-otter
mossy-lantern
silver-cactus
```

The second set varies both components and the types of things being described. I would select it as the lower-confusability candidate set, while treating the magnitude of any human-performance benefit as something to measure.

Two research findings motivate this approach.

First, **cue-overload research** examines how retrieval becomes less effective when the same cue is associated with more events. That provides a basis for investigating whether repeated adjectives or nouns make resource names harder to distinguish. It does not establish that any particular “never repeat a noun” policy is optimal. ([Springer][15])

Second, research involving pharmacists and students found that both spelling similarity and sound similarity increased false recognition of drug names. Drug names are a different domain, but this is direct evidence that name similarity can produce identification errors. ([ScienceDirect][16])

### Apply similarity checks within the user’s actual context

My proposed assignment policy would examine names that the user sees together or has recently used. It would discourage:

**Repeated components.** Avoid assigning many resources the same noun or adjective when alternatives are available.

**Spelling and sound neighbors.** Do not place names such as `blue-bear` and `blue-pear` together merely because they are technically distinct strings.

**Semantic near-duplicates.** Treat `small-otter` and `tiny-otter` as potentially confusing even though a character-distance metric may consider them sufficiently different.

**Recombination traps.** Test whether users confuse studied pairs with new combinations of their components, such as remembering `mossy-otter` after seeing `mossy-lantern` and `sleepy-otter`.

A blanket global prohibition on all similar words would be unnecessarily restrictive. The important context is often a workspace, account, project group, or recent-history window.

### Use spelling distance, but do not mistake it for cognitive distance

EFF demonstrated a word list with a minimum edit distance of three, allowing unique correction of a single insertion, deletion, or substitution under the corresponding edit model. That is a useful coding property, not a complete model of human confusion. ([Electronic Frontier Foundation][10])

For this generator, I would combine character distance with pronunciation similarity and semantic-neighbor checks.

For commands or consequential actions, approximate matching should produce **suggestions**, not silently redirect an operation to another resource.

---

## 5. Build an approved combination set—not two unrestricted dictionaries

The naive implementation is:

```text
choose any adjective × choose any noun
```

My recommended implementation is:

```text
choose an approved adjective–noun pair,
subject to the current context’s distinction rules
```

A convenient representation is a graph: adjectives on one side, nouns on the other, and an edge for each approved combination.

This matters because a word can be acceptable individually while producing an awkward, misleading, or inappropriate phrase with a particular partner.

### Maintain structured word data

These resources can support the screening process:

| Property                           | Useful source                                                  | How I would use it                                                                                          |
| ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Frequency and contextual diversity | SUBTLEX word-frequency data                                    | Screen unfamiliar vocabulary; do not equate corpus frequency with naming quality. ([Universiteit Gent][17]) |
| Concreteness                       | Brysbaert–Warriner–Kuperman norms                              | Shortlist concrete head nouns. ([Springer][6])                                                              |
| Age of acquisition                 | Kuperman and colleagues’ norms                                 | Add another familiarity-related signal. ([Springer][11])                                                    |
| Pronunciation                      | CMU Pronouncing Dictionary                                     | Compare sounds and estimate syllables; supplement for the intended accents and audience. ([GitHub][18])     |
| Emotional associations             | Warriner and colleagues’ valence, arousal, and dominance norms | Flag candidates for review—not act as a toxicity detector. ([Springer][19])                                 |

Alongside those measurements, store grammatical role, intended sense, spelling variants, semantic category, known confusing alternatives, and review status.

For combinations, collect separate judgments of **interpretability, familiarity, imageability, and appropriateness**. Do not collapse them prematurely into an invented “memorability score.”

### Review meaning in the product’s context

I would reserve words such as `trusted`, `secure`, `official`, `admin`, or `production` when they could be mistaken for actual status information.

For labels assigned to people, I would be considerably stricter about words that sound judgmental or derogatory. A playful infrastructure label and a nickname imposed on a person are different design problems.

Check complete phrases, not only word-level blocklists. A sentiment score is not a substitute for that review.

### Separate familiarity from sampling frequency

There is a subtle but important distinction:

> **Choose a vocabulary of familiar words; do not necessarily generate familiar words more often.**

Once candidates meet the quality requirements, an approximately uniform draw from eligible approved pairs is a good initial policy. Weighting generation heavily toward a few words creates repeated components and a more concentrated output distribution.

Also, choosing a noun uniformly and then choosing one of its compatible adjectives uniformly does **not** produce uniform pair probabilities when nouns have different numbers of approved partners. Sampling approved edges directly avoids that particular bias.

### Proposed generation process

Offline, curate the vocabulary, construct acceptable combinations, measure similarities, and version the resulting name set.

At assignment time, remove occupied names and candidates that violate the local confusion policy. Sample from the remaining set, then reserve the result atomically. Persist the assigned alias rather than regenerating it when the word list changes.

Define an explicit fallback for exhaustion: a larger naming scope, a validated three-word scheme, or another documented representation. Do not silently weaken safety or appropriateness filters.

I would also keep an opaque permanent backend identifier separate from the human-facing alias. The naming scheme should improve interaction, not carry the burden of authorization or permanent database identity.

---

## 6. Size the name space correctly

Recent information-theoretic research on human personal-name systems frames a closely related problem: encode many distinguishable identities while keeping the system usable. It examines how combinations of existing vocabulary can expand the identifier space without requiring a unique new word for every person. This supports considering combinatorial naming systems, but does not validate a specific software word list or generation distribution. ([Nature][20])

For your generator, the arithmetic must use the **actual number of approved combinations**.

Suppose, purely as an illustration, there are 256 adjectives and 1,024 nouns, with every combination permitted:

$$
M=256\times1{,}024=262{,}144.
$$

A uniform draw has 18 bits of selection information. Semantic filtering, alliteration requirements, and other restrictions reduce \(M\).

### Distinguish “some collision occurs” from “the next draw collides”

For \(k\) independent uniform draws before checking uniqueness:

$$
P(\text{at least one collision})
\approx 1-\exp\left(-\frac{k(k-1)}{2M}\right).
$$

With the example above, the exact probabilities are approximately:

| Number of draws | Probability that at least one duplicate has occurred |
| --------------: | ---------------------------------------------------: |
|             100 |                                                1.87% |
|           1,000 |                                               85.16% |

These are calculations, not behavioral results.

But with **1,000 distinct names already occupied**, the probability that the next uniform candidate hits one of them is only:

$$
\frac{1{,}000}{262{,}144}\approx0.381\%.
$$

Thus, a high probability of encountering *some* duplicate does not make the scheme unusable when assignments are checked and retried. It does mean “random generation guarantees uniqueness” would be false.

### Nonuniform generation changes the calculation

If name \(i\) has probability \(p_i\), a useful pairwise-collision-equivalent space is:

$$
M_{\text{effective}}=\frac{1}{\sum_i p_i^2}.
$$

A generator heavily concentrated on a few attractive names can have a much smaller effective space than its raw combination count suggests.

Finally, distinguish **machine uniqueness** from **human distinguishability**. Appending different numbers to the same phrase solves string uniqueness, but it does not by itself demonstrate that people can reliably distinguish those resources.

For memory-oriented use, test a third meaningful word before defaulting to numeric suffixes. For copy-oriented workflows, a suffix may be an entirely reasonable tradeoff.

---

## 7. The first production design I would test

Here is the concrete specification I would start with.

| Dimension      | Proposed default                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure      | One attributive adjective followed by one singular concrete noun                                                                                                |
| Word selection | Familiar vocabulary with readily recoverable spelling and pronunciation                                                                                         |
| Pair selection | An approved, readily interpreted phrase; familiar collocations remain eligible                                                                                  |
| Novelty        | Allowed, but no automatic reward for bizarreness                                                                                                                |
| Alliteration   | Allowed, not required                                                                                                                                           |
| Length         | Initially target roughly 3–5 syllables and no more than about 18 characters; treat these as **soft engineering budgets**, not scientifically established optima |
| Representation | Lowercase ASCII words separated by `-`                                                                                                                          |
| Context policy | Avoid exact duplicates, close sound/spelling neighbors, and excessive component reuse among related resources                                                   |
| Safety         | Whole-phrase review and exclusion of misleading status or identity labels                                                                                       |
| Assignment     | Approximately uniform among eligible approved pairs, with atomic uniqueness enforcement                                                                         |
| Persistence    | Stable human alias linked to a separate permanent identifier                                                                                                    |
| Interface      | Full-name display, copy support, search by either component, and no silent substitution of a different resource                                                 |

I would not impose an arbitrary word-list quota at the expense of quality. A carefully reviewed smaller combination set, with explicit scaling behavior, is preferable to claiming a huge space padded with poor candidates.

I would also avoid spending the entire design budget on memory. Show the resource’s purpose or other distinguishing metadata alongside the alias. Provide search and copying. Let users succeed without requiring perfect unaided recall.

---

## 8. How to establish which design is actually best

The final step is a behavioral experiment designed around the real application—not a survey asking which names sound nicest.

### Compare generators in stages

Start with the existing independent-list generator as the baseline. Then compare:

1. A generator with better-curated individual words.
2. A generator with curated words **and combinations**.
3. The same generator with context-aware assignment.

That separates the value of vocabulary, composition, and local discrimination.

Run targeted comparisons for alliteration, familiar versus unusual combinations, noun–noun alternatives, and two versus three words. Avoid changing all those properties simultaneously.

For structural comparisons, report both **length-controlled** and **capacity-aware** results where practical. A two-word scheme and a three-word scheme cannot always be matched on length, vocabulary quality, and name-space size at the same time.

### Test name–entity bindings

Have participants encounter several realistically described resources with generated names. Later, ask them to identify the resource for a given task.

Measure exact name recall separately from correct entity selection. Record adjective omissions, noun substitutions, synonym substitutions, component recombinations, spelling errors, and mistaken selections.

A useful recognition test includes plausible lures, not merely obviously unrelated alternatives.

### Include realistic delays and interaction channels

Test immediate use, delayed use after roughly a day or two, and a longer interval where relevant. Include visual scanning, spoken transcription, mobile and desktop entry, and an ordinary copy/search condition.

Do not repeatedly test the same participants at every delay and interpret the final result as untouched retention. Retrieval testing itself can improve later memory, as demonstrated by Roediger and Karpicke. Use separate retention groups or explicitly model the practice introduced by earlier tests. ([Sage Journals][21])

### Prevent “a few good examples” from becoming a false general conclusion

Use many generated names, not five handpicked favorites. Analyze variation across both participants and names. Reserve unseen vocabulary or combinations for validation.

Predefine the main outcomes and the smallest improvement that would matter operationally. Determine sample size from a pilot and the desired precision rather than choosing a round number.

Recruit from the actual audience, including relevant English proficiency levels, accents, and accessibility needs. Measure preference and appropriateness, but keep them separate from accuracy.

For a consequential application, I would prioritize **wrong-entity error rate**, followed by successful retrieval and task time. A scheme that is slightly slower but materially reduces wrong-target actions may be the better design.

---

## Final recommendation

**Keep adjective–noun as the default, but replace independent random concatenation with a curated, context-aware assignment system.**

The evidence favors taking familiar language seriously, supporting an understandable association between components, and testing interference among competing names. It does not justify universal rules such as “always alliterate,” “always be surprising,” or “exactly four syllables is optimal.”

The design principle I would use is:

> **Familiar parts, an understandable combination, and clearly distinguishable alternatives. Optimize correct use of the named thing—not just recall of a catchy phrase.**

The research supports that direction. What remains unestablished is the exact winning vocabulary, length budget, and similarity thresholds for your workload; the staged experiment above is how those become measured design parameters rather than naming folklore.

[1]: https://link.springer.com/article/10.3758/BF03199660 "https://link.springer.com/article/10.3758/BF03199660"
[2]: https://cups.cs.cmu.edu/soups/2012/proceedings/a7_Shay.pdf "https://cups.cs.cmu.edu/soups/2012/proceedings/a7_Shay.pdf"
[3]: https://pages.cs.wisc.edu/~chatterjee/papers/asiaccs23-mascara.pdf "https://pages.cs.wisc.edu/~chatterjee/papers/asiaccs23-mascara.pdf"
[4]: https://researchconnect.buffalo.edu/en/publications/phrase-frequency-effects-in-free-recall-evidence-for-redintegrati/ "Phrase frequency effects in free recall: Evidence for redintegration - SUNY University at Buffalo"
[5]: https://link.springer.com/article/10.3758/BF03335632 "https://link.springer.com/article/10.3758/BF03335632"
[6]: https://link.springer.com/article/10.3758/s13428-013-0403-5 "https://link.springer.com/article/10.3758/s13428-013-0403-5"
[7]: https://link.springer.com/article/10.3758/BF03212428 "https://link.springer.com/article/10.3758/BF03212428"
[8]: https://journals.sagepub.com/doi/10.1177/0033688214522714 "https://journals.sagepub.com/doi/10.1177/0033688214522714"
[9]: https://bpspsychub.onlinelibrary.wiley.com/doi/10.1111/bjop.12575 "https://bpspsychub.onlinelibrary.wiley.com/doi/10.1111/bjop.12575"
[10]: https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases "https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases"
[11]: https://link.springer.com/article/10.3758/s13428-012-0210-4 "https://link.springer.com/article/10.3758/s13428-012-0210-4"
[12]: https://adele.scholar.princeton.edu/document/576 "https://adele.scholar.princeton.edu/document/576"
[13]: https://www.researchgate.net/publication/9478060_Learning_of_adjective-noun_paired_associates_as_a_function_of_adjective-noun_word_order_and_noun_abstractness "https://www.researchgate.net/publication/9478060_Learning_of_adjective-noun_paired_associates_as_a_function_of_adjective-noun_word_order_and_noun_abstractness"
[14]: https://alpslab.stanford.edu/papers/2017ScontrasDegenEtAl.pdf "https://alpslab.stanford.edu/papers/2017ScontrasDegenEtAl.pdf"
[15]: https://link.springer.com/article/10.3758/BF03337192 "https://link.springer.com/article/10.3758/BF03337192"
[16]: https://www.sciencedirect.com/science/article/abs/pii/S0277953600003014 "https://www.sciencedirect.com/science/article/abs/pii/S0277953600003014"
[17]: https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus "https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus"
[18]: https://github.com/cmusphinx/cmudict "https://github.com/cmusphinx/cmudict"
[19]: https://link.springer.com/article/10.3758/s13428-012-0314-x "https://link.springer.com/article/10.3758/s13428-012-0314-x"
[20]: https://www.nature.com/articles/s41467-025-67079-8 "https://www.nature.com/articles/s41467-025-67079-8"
[21]: https://journals.sagepub.com/doi/10.1111/j.1467-9280.2006.01693.x "https://journals.sagepub.com/doi/10.1111/j.1467-9280.2006.01693.x"

