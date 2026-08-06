import json, glob, os
root = r'D:\openloomi3\openloomi\benchmark\jobbench-official\dataset\main'
files = glob.glob(os.path.join(root, '*', 'task*', 'eval_result', 'eval_openloomi-dev', 'MiniMax-M3-highspeed_judge.json'))
print('files:', len(files))
score=0; mx=0; p=0; t=0; rows=[]
for f in files:
    d = json.load(open(f, encoding='utf-8'))
    task = f[len(root)+1:].split(os.sep + 'eval_result' + os.sep, 1)[0].replace('/', '/')
    rows.append((task, d['total_score'], d['max_score'], d['passed_count'], d['total_count'], d['pass_rate']))
    score += d['total_score']; mx += d['max_score']; p += d['passed_count']; t += d['total_count']
rows.sort(key=lambda r: r[0])
print()
hdr = "{:<55} {:>6} {:>6} {:>5} {:>1} {:>4} {:>7}".format("task", "score", "max", "pass", "/", "tot", "rate")
print(hdr)
print('-'*90)
for task,sc,mm,pp,tt,rate in rows:
    print("{:<55} {:>6} {:>6} {:>5} {:>1} {:>4} {:>6}%".format(task, sc, mm, pp, '/', tt, rate))
print('-'*90)
print("{:<55} {:>6} {:>6} {:>5} {:>1} {:>4} {:>6.1f}%".format("TOTAL", score, mx, p, '/', t, 100*p/t))
print()
print("aggregate normalised score = {:.4f}".format(score/mx if mx else 0.0))

# Top 10 best / worst
by_rate = sorted(rows, key=lambda r: -(r[5].rstrip('%') and (100*int(r[3])/int(r[4])) if r[4] else 0))
print()
print("Top 5 by pass_rate:")
for r in by_rate[:5]:
    print("  ", r[0], "{:>3}/{:>3}".format(r[3], r[4]), "({:>5}%)".format(r[5]), "score", "{}/{}".format(r[1], r[2]))
print("Bottom 5 by pass_rate:")
for r in by_rate[-5:]:
    print("  ", r[0], "{:>3}/{:>3}".format(r[3], r[4]), "({:>5}%)".format(r[5]), "score", "{}/{}".format(r[1], r[2]))
