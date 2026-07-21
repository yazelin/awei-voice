# Third-party notices

The repository's MIT license applies only to this project's own source code. It does not relicense third-party packages, model weights, online services, generated audio, or separately installed software.

## Browser document parsers

- Mozilla PDF.js / `pdfjs-dist@6.1.200`: Apache License 2.0
- Mammoth / `mammoth@1.12.0`: BSD 2-Clause License
- Mammoth's bundled browser dependencies: MIT, ISC, BSD, zlib, or the package's documented dual-license terms

The deployed website includes the shipped production browser-package license material in [`public/THIRD_PARTY_LICENSES.txt`](public/THIRD_PARTY_LICENSES.txt). It is copied to `/awei-voice/THIRD_PARTY_LICENSES.txt` and linked from the website footer. Optional Node-only PDF.js canvas packages are disabled by the browser build.

## Taigi News Reader backend

- Source: <https://github.com/yazelin/taigi-news-reader>
- Exact revision: pinned in [`server/pyproject.toml`](server/pyproject.toml)
- Upstream source-code license: MIT

The web server wraps the pinned backend's asynchronous synthesis API. Preserve the upstream MIT notice when redistributing substantial portions of that software.

> MIT License
>
> Copyright (c) 2026 taigi-news-reader contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Meta `facebook/mms-tts-nan`

- Model page: <https://huggingface.co/facebook/mms-tts-nan>
- Upstream MMS project: <https://huggingface.co/facebook/mms-tts>
- License identified by the publisher: CC BY-NC 4.0
- License text: <https://creativecommons.org/licenses/by-nc/4.0/>

The checkpoint is downloaded separately and is not covered by this repository's MIT license. CC BY-NC 4.0 includes attribution and non-commercial restrictions. Do not use this reference checkpoint for a commercial service without obtaining suitable permission or replacing it.

The hosted Taigi path runs this checkpoint on the deployment host. The model is identified as experimental **Min Nan**; `nan` coverage does not prove a natural Taiwanese accent, correct Taiwanese Hokkien pronunciation, or the quality implied by 「正宗」. Native-speaker review in [`docs/listening-test.md`](docs/listening-test.md) has not been completed.

MMS consumes a narrow POJ-compatible alphabet in this deployment. Chinese-character input must first be translated to POJ. Direct input requires diacritic-tone POJ accepted by that checkpoint; numeric tone notation and direct Han-character Taiwanese text synthesis are not supported.

Suggested attribution: Vineel Pratap et al., “Scaling Speech Technology to 1,000+ Languages,” 2023.

## `edge-tts`

- Project: <https://github.com/rany2/edge-tts>
- Locked version: see [`server/uv.lock`](server/uv.lock)
- License: LGPL-3.0 for the library, except `src/edge_tts/srt_composer.py`, which is MIT
- License text: <https://github.com/rany2/edge-tts/blob/master/LICENSE>

`edge-tts` is a third-party, unofficial client for the online text-to-speech service used by Microsoft Edge. The hosted Taiwan Mandarin fallback sends Mandarin text through this client to that online service. It is network-only and has no availability, continuity, voice-stability, or service-level guarantee from this project. The library's open-source license does not grant rights to Microsoft services, voices, or generated content; operators and users must separately assess the applicable service terms and intended use.

The server-side package is not part of the browser JavaScript bundle. A short public notice is also included in [`public/THIRD_PARTY_LICENSES.txt`](public/THIRD_PARTY_LICENSES.txt) so the deployed website discloses the online fallback.

## Groq-hosted translation

- Service: <https://groq.com/>
- API documentation: <https://console.groq.com/docs/>

The production 「華語翻成台語」 path sends the current Mandarin text segment to a Groq-hosted model to produce experimental POJ. Groq is an external data processor and online service, not a package relicensed by this repository. Its terms, privacy practices, retention controls, model availability, quotas, and pricing may change independently.

The Groq result is checked for the expected romanization character set, but that is not linguistic validation. It may contain mistranslations, inappropriate word choice, names or numbers read incorrectly, or non-native phrasing. Do not label it 「正宗」 or native-speaker-validated until the documented listening review passes.

## Ollama and Qwen

The optional local pipeline can call a separately installed Ollama runtime and a separately downloaded Qwen model. They are not bundled in this Git repository. Check the exact Ollama runtime and selected model license before redistribution or deployment.

Ollama/Qwen is an alternative local Traditional-Chinese-to-Taiwanese-Hokkien translation path. Passing the POJ character gate is not linguistic validation; a Taiwanese Hokkien native speaker must still review meaning, word choice, pronunciation, names, places, dates, numbers, and loan words.
