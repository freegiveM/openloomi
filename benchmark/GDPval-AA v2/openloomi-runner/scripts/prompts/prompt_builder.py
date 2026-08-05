"""Build the official GDPval-AA v2 task submission prompt and system prompt.

This is a *copy* of the prompt templates shipped in
`grader/GDPVal_EVal/gdpval/submission/prompt.py`, kept here so the
OpenLoomi runner can construct prompts without taking a runtime dependency
on the `gdpval` Python package. The two should stay in lockstep — when you
update one, mirror the change in the other.

Output: prints a single JSON line to stdout:
    {"system_prompt": "...", "task_prompt": "..."}

Usage:
    python prompt_builder.py \\
        --task-prompt "<raw task prompt from gdpval>" \\
        --reference-files "/abs/path/a.xlsx" "/abs/path/b.pdf" \\
        --finish-tool-name "finish" \\
        --abandon-tool-name "abandon_task_finish"
"""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
from typing import List, Optional

# ---------------------------------------------------------------------------
# v2 system prompt (verbatim from the AA methodology page)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are an AI agent completing a standalone professional task. Your job is "
    "to use the provided tools to produce the requested deliverables within 250 "
    "steps, then submit your work.\n\n"
    "When you are done, call the `finish` tool as your final step with:\n"
    "1. A brief summary of what you accomplished.\n"
    "2. Absolute paths to every deliverable file.\n\n"
    "If you have genuinely concluded that the task cannot be completed because "
    "required inputs are missing, a hard dependency is unavailable, or the "
    "request is incoherent, call the `abandon_task_finish` tool with a brief "
    "reason instead. Do not use it to escape difficulty.\n\n"
    "You cannot interact with the user during the task. Make reasonable "
    "assumptions when needed and record them in your finish summary."
)

# ---------------------------------------------------------------------------
# v2 task submission prompt (verbatim from the AA methodology page)
# ---------------------------------------------------------------------------
TASK_SUBMISSION_PROMPT = textwrap.dedent(
    """
    ## Runtime

    You are running in an isolated Linux sandbox. Use the `code_exec` tool to read, create, and modify files. Commands run as the non-root user `user` (UID 1000). Default working directory is `/home/user`.

    Every command runs independently: no working directory, environment variables, or shell state persists between calls. Use absolute paths and set them explicitly. Do not rely on interactive prompts. The first character of every shell command must not be `#` (it would be treated as a root prompt by the harness).

    ## Environment

    Your environment comes preinstalled with a comprehensive set of Python packages and system tools:

    **Jupyter Ecosystem:**
    - jupyter-client 8.6.1, jupyter-core 5.5.1, jupyter-server 2.14.0
    - jupyterlab 4.1.8, jupyterlab-pygments 0.3.0, jupyterlab-server 2.27.1
    - notebook 6.5.1, nbclassic 0.4.5

    **Web Frameworks:**
    - aiohttp 3.9.5, hypercorn 0.14.3, fastapi 0.95.2, websockets 10.3
    - pydantic 1.10.2, gradio 2.2.15

    **Core Data Science:**
    - numpy 1.24.0, numpy-financial 1.0.0, scipy 1.14.1, pandas 1.5.3
    - matplotlib 3.6.3, matplotlib-venn 0.11.6, seaborn 0.11.2
    - plotly 5.3.0, plotnine 0.10.1, bokeh 2.4.0

    **Statistics & Machine Learning:**
    - statsmodels 0.13.5, scikit-learn 1.1.3, scikit-image 0.20.0
    - xgboost 1.4.2, catboost ~1.2.7, lightgbm ~4.5.0
    - imbalanced-learn ~0.12.3, shap 0.39.0

    **NLP:**
    - nltk 3.9.1, gensim 4.3.1, spacy 3.4.4, textblob 0.15.3

    **Computer Vision:**
    - opencv-python 4.5.5.62, Pillow 9.1.0
    - pytesseract 0.3.8, qrcode 7.3, pyzbar 0.1.8, imgkit 1.2.2

    **Audio Processing:**
    - ffmpeg-python 0.2.0, pydub 0.25.1, moviepy 1.0.3, soundfile 0.10.2
    - librosa 0.8.1, mutagen 1.45.1, gtts 2.2.3, pyttsx3 2.90
    - pedalboard 0.9.9, pyloudnorm 0.1.1, mne 0.23.4

    **Document Processing:**
    - python-docx 0.8.11, python-pptx 0.6.21, openpyxl 3.0.10, xlrd 2.0.1
    - PyMuPDF 1.21.1, pdf2image 1.16.3, pdfplumber 0.6.2, pdfkit 0.6.1
    - pypandoc 1.6.3, docx2txt 0.8, odfpy 1.4.1, pyxlsb 1.0.8
    - tabula 1.0.5, camelot-py 0.10.1

    **PDF Generation:**
    - fpdf2 2.8.3, reportlab 3.6.12, weasyprint 53.3, pdfrw 0.4

    **Graphics & Visualization:**
    - graphviz 0.17, pydot 1.4.2, networkx 2.8.8
    - svglib 1.1.0, svgwrite 1.4.1, cairosvg 2.5.2, trimesh 3.9.29
    - wordcloud 1.9.2, folium 0.12.1

    **Geospatial:**
    - shapely 2.0.6, fiona 1.9.2, geopandas 0.10.2
    - geopy 2.2.0, rasterio 1.3.3, basemap 1.3.9
    - GDAL system libraries

    **Scientific Computing:**
    - sympy 1.13.1, pymc 4.0.1, h5py 3.8.0, tables 3.8.0

    **3D & CAD:**
    - cadquery 2.4.0, cadquery-ocp 7.7.0

    **Chemistry & Biology:**
    - rdkit 2024.9.6, biopython 1.84

    **Data Utilities:**
    - xml-python 0.4.3, markdownify 0.9.3, anytree 2.8.0
    - rarfile 4.0, chardet 3.0.4, srt 3.5.3

    **General Utilities:**
    - tqdm 4.64.0, tabulate 0.9.0, faker 8.13.2, loguru 0.5.3
    - fuzzywuzzy 0.18.0, rapidfuzz ~3.10.1, einops 0.3.2
    - pycountry 20.7.3, countryinfo 0.1.2, pronouncing 0.2.0
    - kerykeion 2.1.16, exchange_calendars 3.4

    **Math & Logic:**
    - pylog 1.1, pyprover 0.5.6, nashpy 0.0.0

    **Semantic Web:**
    - rdflib 6.0.0

    **Security & Networking:**
    - cryptography 3.4.8, pyopenssl 21.0.0, requests 2.31.0

    **Database Connectors:**
    - snowflake-connector-python 2.7.12, databricks-sql-connector 0.9.1

    **Testing & Monitoring:**
    - pytest 8.2.0, pytest-cov 5.0.0, pytest-json-report 1.5.0
    - coverage 7.5.1, pytest-asyncio 0.23.6
    - ddtrace 2.8.1, datadog 0.49.1

    **Document Generation:**
    - aspose-words 25.8.0

    **Other:**
    - typing-extensions 4.10.0, pyth3 0.7

    **System Tools:**
    - Python 3.10 (base environment)
    - LibreOffice + LibreOffice Writer (for office document conversion, includes fonts-dejavu-core)
    - Tesseract OCR (text extraction from images)
    - Pandoc (universal document converter)
    - Poppler utilities (PDF tools such as `pdftotext`, `pdfimages`)
    - Ghostscript (PostScript/PDF processing)
    - FFmpeg (complete audio/video processing suite with all codecs)
    - Graphviz (graph visualization with DOT language)
    - OpenJDK 21 JRE (Java runtime for Tabula and other Java-based tools)
    - GDAL/GEOS/Proj (geospatial data utilities and libraries)
    - Build tools: gcc, g++, cmake, pkg-config, make
    - Full TeX Live LaTeX toolchain (pdflatex, xelatex, lualatex, latexmk, etc.)

    ## Reference Files Location

    The reference files for the task are available in your working directory.

    Here are their paths:

    <reference_files>
    {reference_files}
    </reference_files>

    ## Completing Your Work

    In order to complete the task you must use the `{finish_tool_name}` tool to submit your work.  If you do not use the `{finish_tool_name}` tool you will fail this task!

    **Required in your finish call:**
    1. A brief summary of what you accomplished
    2. A list of **ABSOLUTE file paths** (starting with `/home/user/`) for all files you want to submit.

    ## Task

    Here is the task you need to complete:

    <task>
    {task}
    </task>

    Please begin working on the task now.
    """
).strip()


def build(
    task: str,
    reference_files: List[str],
    finish_tool_name: str = "finish",
    abandon_tool_name: str = "abandon_task_finish",
) -> dict:
    """Return the v2 system prompt + task prompt."""
    ref_block = "\n".join(reference_files) if reference_files else "(none)"
    task_prompt = TASK_SUBMISSION_PROMPT.format(
        task=task,
        reference_files=ref_block,
        finish_tool_name=finish_tool_name,
    )
    # The system prompt mentions both tools; we keep it identical to the
    # methodology page so models trained against that text behave the same.
    return {"system_prompt": SYSTEM_PROMPT, "task_prompt": task_prompt}


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--task-prompt", required=True)
    p.add_argument(
        "--reference-files",
        nargs="*",
        default=[],
        help="Absolute paths to reference files (in workDir)",
    )
    p.add_argument("--finish-tool-name", default="finish")
    p.add_argument("--abandon-tool-name", default="abandon_task_finish")
    p.add_argument(
        "--system-prompt-only",
        action="store_true",
        help="Only print the system prompt (for testing / debugging)",
    )
    p.add_argument(
        "--task-prompt-only",
        action="store_true",
        help="Only print the task prompt",
    )
    args = p.parse_args(argv)

    if args.system_prompt_only:
        sys.stdout.write(SYSTEM_PROMPT)
        return 0
    if args.task_prompt_only:
        result = build(
            args.task_prompt,
            args.reference_files,
            args.finish_tool_name,
            args.abandon_tool_name,
        )
        sys.stdout.write(result["task_prompt"])
        return 0

    result = build(
        args.task_prompt,
        args.reference_files,
        args.finish_tool_name,
        args.abandon_tool_name,
    )
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
