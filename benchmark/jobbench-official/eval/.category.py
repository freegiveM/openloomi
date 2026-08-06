# Map each JobBench profession (folder name under dataset/main) to a coarse
# 7-category bucket that mirrors the chart from the JobBench paper (Figure 2's
# 10 SOC groups, with Engineering merged into Arch and a few sparse SOC groups
# folded into "Others").  Each entry is keyed on the O*NET-SOC 2018 major group
# the profession belongs to, with the bucket chosen by name.

# Per the user, the following collapses were applied:
#   - Computer (15-12XX) + Mathematical Science (15-20XX) -> "CompMath"
#   - Business (13-1000) + Financial Operations (13-2000) -> "BusFin"
# Both follow the JobBench paper's treatment of SOC major group 13-0000 and
# 15-0000 as single buckets.

# Mapping rationale (BLS SOC 2018 Major Group):
#   BusFin     -- 13-0000  Business & Financial Operations (operations specialists, buyers,
#                          agents, financial analysts / advisors / examiners)
#   Admin      -- 43-0000  Office & Administrative Support (bookkeepers, secretaries,
#                          data-entry, dispatchers, customer service, licensing clerks)
#   CompMath   -- 15-0000  Computer & Mathematical (researchers, sysadmins, support,
#                          web, statisticians, biostatisticians)
#   Arch       -- 17-0000  Architecture & Engineering (civil/mech/petroleum engineers,
#                          mechanical engineering technicians)
#   Mgmt       -- 11-0000  Management Occupations (HR, medical/health, training/dev,
#                          CIS, financial-managers, purchasing-managers, supply-chain)
#   Arts       -- 27-0000  Arts/Design/Entertainment/Sports/Media (reporters, producers,
#                          technical writers)
#   Others     -- everything else (legal, life/physical/social science, education,
#                          protective service, healthcare support) -- catch-all for
#                          professions whose SOC major groups are not in the 6 buckets
#                          above.  Includes lawyers (23), sociologists (19-30XX),
#                          social-science research assistants (19-40XX), training &
#                          dev specialists (13-1151 -- placed in Mgmt here).

# Primary metric reported per category: JobBench "weighted score"
# (a.k.a. normalised score, total_score / max_score per task), which is the
# metric used in the JobBench paper (Figure 5, Table 4).  Per-rubric pass
# rate is reported as a secondary column.

import json, glob, os, sys, collections

# (profession_dir_name, SOC_2018_code, bucket, human-readable title)
PROFESSIONS = [
    # --- Comp (15-12XX) ---
    ("computer_and_information_research_scientists", "15-1221", "CompMath", "Computer & Information Research Scientists"),
    ("computer_and_information_systems_managers",  "11-3021", "Mgmt", "Computer & Information Systems Managers"),
    ("computer_user_support_specialists",            "15-1232", "CompMath", "Computer User Support Specialists"),
    ("web_administrators",                           "15-1244", "CompMath", "Network & Computer Systems Admin / Web Admin"),

    # --- Math (15-20XX) ---
    ("biostatisticians",                             "15-2041", "CompMath", "Biostatisticians"),
    ("statisticians",                                "15-2042", "CompMath", "Statisticians"),

    # --- Arch (17-0000) ---
    ("civil_engineers",                              "17-2051", "Arch", "Civil Engineers"),
    ("mechanical_engineers",                         "17-2141", "Arch", "Mechanical Engineers"),
    ("petroleum_engineers",                          "17-2171", "Arch", "Petroleum Engineers"),
    ("mechanical_engineering_technicians",           "17-3027", "Arch", "Mechanical Engineering Technicians"),

    # --- BusFin (13-0000) ---
    ("management_analysts",                          "13-1111", "BusFin", "Management Analysts"),
    ("market_research_analysts_and_marketing_specialists", "13-1161", "BusFin", "Market Research Analysts (proxy, no folder)"),
    ("purchasing_agents_except_wholesale_retail_and_farm_products",
                                                      "13-1023", "BusFin", "Purchasing Agents (excl. wholesale/retail/farm)"),
    ("producers",                                    "27-2012", "Arts",   "Producers (Film/TV)"),
    ("sales_agents_securities_and_commodities",      "41-3031", "BusFin", "Securities & Commodities Sales Agents"),
    ("sales_representatives_wholesale_and_manufacturing_technical_and_scientific_products",
                                                      "41-4011", "BusFin", "Wholesale/Manufacturing Technical Sales Reps"),
    ("online_merchants",                             "13-1199", "BusFin", "Online Merchants / E-commerce specialists"),

    # --- BusFin (13-205X personal financial advisors / financial analysts) ---
    ("financial_managers_branch_or_department",     "11-3031", "Mgmt",   "Financial Managers"),
    ("personal_financial_advisors",                  "13-2052", "BusFin", "Personal Financial Advisors"),

    # --- Admin (43-0000) ---
    ("bookkeeping_accounting_and_auditing_clerks",   "43-3031", "Admin","Bookkeeping/Accounting/Auditing Clerks"),
    ("court_clerks",                                 "43-4031", "Admin","Court Clerks"),
    ("customer_service_representatives",             "43-4051", "Admin","Customer Service Representatives"),
    ("data_entry_keyers",                            "43-9021", "Admin","Data Entry Keyers"),
    ("licensing_examiners_and_inspectors",           "13-1041", "Admin","Compliance Officers / Licensing Examiners"),
    ("medical_secretaries",                          "43-6013", "Admin","Medical Secretaries"),
    ("police_fire_and_ambulance_dispatchers",        "43-5031", "Admin","Police/Fire/Ambulance Dispatchers"),
    ("secretaries_and_administrative_assistants_except_legal_medical_and_executive",
                                                      "43-6014", "Admin","Secretaries & Administrative Assistants"),

    # --- Mgmt (11-0000) ---
    ("human_resources_specialists",                 "13-1071", "Mgmt", "Human Resources Specialists"),
    ("medical_and_health_services_managers",        "11-9111", "Mgmt", "Medical & Health Services Managers"),
    ("training_and_development_specialists",        "13-1151", "Mgmt", "Training & Development Specialists"),
    ("supply_chain_managers",                       "11-3071", "Mgmt", "Supply Chain / Transportation Managers"),

    # --- Arts (27-0000) ---
    ("reporters_and_correspondents",                "27-3022", "Arts", "Reporters & Correspondents"),
    ("technical_writers",                           "27-3042", "Arts", "Technical Writers"),

    # --- Others (everything else) ---
    ("lawyers",                                      "23-1011", "Others", "Lawyers"),
    ("sociology_teachers_postsecondary",             "25-1069", "Others", "Sociology Teachers, Postsecondary"),
    ("social_science_research_assistants",           "19-4061", "Others", "Social Science Research Assistants"),
]

# Index by folder name
PROFESSION_BY_DIR = {p[0]: p for p in PROFESSIONS}

CATEGORIES = ["BusFin", "Admin", "CompMath", "Arch", "Mgmt", "Arts", "Others"]

ROOT = r"D:\openloomi3\openloomi\benchmark\jobbench-official\dataset\main"
files = glob.glob(os.path.join(ROOT, "*", "task*", "eval_result", "eval_openloomi-dev", "MiniMax-M3-highspeed_judge.json"))
print(f"judge files found: {len(files)}")

agg = {c: {"tasks": 0, "score": 0, "max": 0, "passed": 0, "total_rubrics": 0, "members": []} for c in CATEGORIES}
unmapped = []

for f in files:
    rel = f[len(ROOT) + 1:]
    parts = rel.split(os.sep)
    prof_dir = parts[0]
    task = parts[1]
    if prof_dir not in PROFESSION_BY_DIR:
        unmapped.append(prof_dir)
        continue
    _, soc, cat, title = PROFESSION_BY_DIR[prof_dir]
    d = json.load(open(f, encoding="utf-8"))
    score, mx, p, t = d["total_score"], d["max_score"], d["passed_count"], d["total_count"]
    agg[cat]["tasks"] += 1
    agg[cat]["score"] += score
    agg[cat]["max"]   += mx
    agg[cat]["passed"] += p
    agg[cat]["total_rubrics"] += t
    agg[cat]["members"].append((prof_dir, task, soc, title, score, mx, p, t, d["pass_rate"]))

print()
hdr = "{:<10} {:>10}  {:>10}  {}".format(
    "Category", "wtd_score", "rub_pass", "professions")
print(hdr)
print("-" * 130)

total_score, total_max, total_p, total_t = 0, 0, 0, 0
for c in CATEGORIES:
    a = agg[c]
    if a["tasks"] == 0:
        print("{:<10} --".format(c))
        continue
    wtd = 100.0 * a["score"] / a["max"] if a["max"] else 0.0
    rate = 100.0 * a["passed"] / a["total_rubrics"] if a["total_rubrics"] else 0
    members = sorted(set(m[3] for m in a["members"]))
    print("{:<10} {:>9.2f}%  {:>9.1f}%  {}".format(
        c, wtd, rate, "; ".join(members)))
    total_score += a["score"]
    total_max   += a["max"]
    total_p     += a["passed"]
    total_t     += a["total_rubrics"]
print("-" * 130)
total_wtd  = 100.0 * total_score / total_max if total_max else 0
total_rate = 100.0 * total_p / total_t if total_t else 0
print("{:<10} {:>9.2f}%  {:>9.1f}%".format("TOTAL", total_wtd, total_rate))

if unmapped:
    print("\nUNMAPPED professions:", unmapped)

print("\n\n--- Detailed per-task rollup by category ---")
for c in CATEGORIES:
    a = agg[c]
    if not a["members"]:
        continue
    cat_wtd  = 100.0 * a["score"] / a["max"] if a["max"] else 0.0
    cat_rate = 100.0 * a["passed"] / a["total_rubrics"] if a["total_rubrics"] else 0
    print("\n[{}]  weighted_score={:.2f}%  rubric_pass={:.1f}%  ({}/{} rubrics, {} task(s))".format(
        c, cat_wtd, cat_rate, a["passed"], a["total_rubrics"], a["tasks"]))
    members = sorted(set((m[0], m[2], m[3]) for m in a["members"]))
    for prof, soc, title in members:
        print("  {:<55} {}".format("{} ({})".format(title, soc), prof))
    for prof, task, soc, title, score, mx, p, t, rate in sorted(a["members"]):
        task_wtd = 100.0 * score / mx if mx else 0.0
        print("    {:<55}  wtd={:>6.2f}%  score={:>3}/{:<3}  pass={:>3}/{:<3}  ({:>5})".format(
            "{}/{}".format(prof, task), task_wtd, score, mx, p, t, rate))