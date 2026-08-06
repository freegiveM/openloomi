$tasks = @(
    "mechanical_engineering_technicians/task1",
    "sociology_teachers_postsecondary/task3",
    "statisticians/task1",
    "statisticians/task2",
    "statisticians/task3",
    "technical_writers/task3",
    "training_and_development_specialists/task1",
    "training_and_development_specialists/task2",
    "training_and_development_specialists/task3",
    "web_administrators/task1"
)
$root = "D:\openloomi3\openloomi\benchmark\jobbench-official"
Set-Location $root

$argList = @("eval\run_benchmark_openloomi.py", "--split", "main")
foreach ($t in $tasks) { $argList += @("--task", $t) }

Write-Host "Resuming $($tasks.Count) JobBench tasks..."
& python @argList
