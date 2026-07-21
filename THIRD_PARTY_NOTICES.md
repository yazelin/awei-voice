# Third-party notices

The repository's MIT license applies to this project's own source code. It
does not relicense the following dependency, model weights, generated audio,
or separately installed software and models.

## Browser document parsers

- Mozilla PDF.js / `pdfjs-dist@6.1.200`: Apache License 2.0
- Mammoth / `mammoth@1.12.0`: BSD 2-Clause License
- Mammoth's bundled browser dependencies: MIT, ISC, BSD, zlib, or the package's
  documented dual-license terms

The deployed website includes a readable copy of every production browser
package's shipped license material at
[`public/THIRD_PARTY_LICENSES.txt`](public/THIRD_PARTY_LICENSES.txt). That file
is copied to the Pages artifact as `/awei-voice/THIRD_PARTY_LICENSES.txt` and is
linked directly from the website footer. Optional Node-only PDF.js canvas
packages are disabled by the browser build and are not included in that list.

## Taigi News Reader backend

- Source: https://github.com/yazelin/taigi-news-reader
- Pinned revision: `967d7370fb5f3b22cc4492c5ee5753fba3ae2904`
- Upstream source-code license: MIT

The web server installs the backend from that exact Git revision and wraps its
asynchronous synthesis API. Preserve the upstream MIT notice when
redistributing substantial portions of that software.

> MIT License
>
> Copyright (c) 2026 taigi-news-reader contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Meta `facebook/mms-tts-nan`

- Model page: https://huggingface.co/facebook/mms-tts-nan
- Upstream MMS project: https://huggingface.co/facebook/mms-tts
- License identified by the publisher: CC BY-NC 4.0
- License text: https://creativecommons.org/licenses/by-nc/4.0/

The checkpoint is downloaded separately and is not included in this Git
repository or covered by its MIT license. CC BY-NC 4.0 includes attribution and
non-commercial restrictions; do not use this reference checkpoint for a
commercial service without obtaining suitable permission or replacing it.

The checkpoint is an experimental **Min Nan** speech model for this product.
Its label and ISO 639-3 `nan` coverage do not prove that every output has a
natural Taiwanese accent, correct Taiwanese Hokkien pronunciation, or the
quality implied by 「正宗」. Until the product-spec R6 native-speaker listening
review passes, the UI and deployment must identify it as experimental.

The first real synthesis can download the checkpoint and its runtime
dependencies from external package/model hosts. That first-download phase is
not offline. Only after every required artifact has been downloaded and kept
in the configured cache can an operator test synthesis with external network
access removed.

Suggested attribution: Vineel Pratap et al., “Scaling Speech Technology to
1,000+ Languages,” 2023.

## Ollama and Qwen

The local reference pipeline can call a separately installed Ollama runtime
and a separately downloaded Qwen model. They are not bundled in this Git
repository. Check the exact Ollama image/runtime and selected model's license
before redistribution or deployment.

Qwen-through-Ollama is an experimental Traditional-Chinese-to-Taiwanese-
Hokkien translation reference. Passing the backend's POJ character checks is
not linguistic validation: a Taiwanese Hokkien native speaker must review
meaning, word choice, pronunciation, names, places, dates, numbers, and loan
words before the translation can be presented as validated or 「正宗」.
