"""Apple Saúde a partir da exportação do iPhone (Saúde → foto do perfil → Exportar Todos os Dados).

O arquivo pode ter centenas de MB; a leitura é em fluxo (iterparse) e só o resumo dos últimos
60 dias fica guardado. Os dados são tão recentes quanto a última exportação.
"""

import datetime as dt
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any

DAYS = 60

SUM = {
    "HKQuantityTypeIdentifierStepCount": "passos",
    "HKQuantityTypeIdentifierActiveEnergyBurned": "kcal_ativas",
    "HKQuantityTypeIdentifierDistanceWalkingRunning": "km",
}
AVG = {
    "HKQuantityTypeIdentifierRestingHeartRate": "fc_repouso",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "vfc",
    "HKQuantityTypeIdentifierOxygenSaturation": "spo2",
}
ASLEEP = {"HKCategoryValueSleepAnalysisAsleep", "HKCategoryValueSleepAnalysisAsleepCore",
          "HKCategoryValueSleepAnalysisAsleepDeep", "HKCategoryValueSleepAnalysisAsleepREM",
          "HKCategoryValueSleepAnalysisAsleepUnspecified"}


def _date(s: str) -> dt.datetime:
    return dt.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")


def parse(path: Path) -> dict[str, Any]:
    since = dt.datetime.now() - dt.timedelta(days=DAYS)
    sums: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    avgs: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    sleep: dict[str, float] = defaultdict(float)
    workouts: list[dict[str, Any]] = []

    def source():
        if zipfile.is_zipfile(path):
            z = zipfile.ZipFile(path)
            name = next(n for n in z.namelist() if n.endswith("export.xml") and "cda" not in n)
            return z.open(name)
        return open(path, "rb")

    with source() as fh:
        for _, el in ET.iterparse(fh, events=("end",)):
            tag = el.tag
            if tag == "Record":
                t = el.get("type")
                start = el.get("startDate")
                if not start or (t not in SUM and t not in AVG and t != "HKCategoryTypeIdentifierSleepAnalysis"):
                    el.clear()
                    continue
                d0 = _date(start)
                if d0 < since:
                    el.clear()
                    continue
                if t in SUM:
                    v = float(el.get("value") or 0)
                    if t == "HKQuantityTypeIdentifierDistanceWalkingRunning" and el.get("unit") == "m":
                        v /= 1000
                    sums[SUM[t]][d0.strftime("%Y-%m-%d")] += v
                elif t in AVG:
                    v = float(el.get("value") or 0)
                    if t == "HKQuantityTypeIdentifierOxygenSaturation" and v <= 1:
                        v *= 100
                    avgs[AVG[t]][d0.strftime("%Y-%m-%d")].append(v)
                elif el.get("value") in ASLEEP:
                    d1 = _date(el.get("endDate"))
                    night = (d1 - dt.timedelta(hours=12)).strftime("%Y-%m-%d")  # noite atribuída ao dia em que começou
                    sleep[night] += (d1 - d0).total_seconds() / 3600
            elif tag == "Workout":
                start = el.get("startDate")
                if start and _date(start) >= since:
                    dur = float(el.get("duration") or 0)
                    if el.get("durationUnit") == "s":
                        dur /= 60
                    workouts.append({
                        "data": start[:10],
                        "tipo": (el.get("workoutActivityType") or "").replace("HKWorkoutActivityType", ""),
                        "min": round(dur),
                        "kcal": round(float(el.get("totalEnergyBurned") or 0)),
                    })
            if tag in ("Record", "Workout"):
                el.clear()

    days = [(dt.date.today() - dt.timedelta(days=i)).isoformat() for i in range(DAYS - 1, -1, -1)]
    serie = []
    for d in days:
        row: dict[str, Any] = {"data": d}
        for k in SUM.values():
            v = sums[k].get(d)
            row[k] = round(v, 1) if v else None
        for k in AVG.values():
            vals = avgs[k].get(d)
            row[k] = round(sum(vals) / len(vals), 1) if vals else None
        row["sono_h"] = round(sleep[d], 1) if sleep.get(d) else None
        serie.append(row)
    workouts.sort(key=lambda w: w["data"], reverse=True)
    last = next((r for r in reversed(serie) if r["passos"]), None)
    return {"atualizado": dt.datetime.now().strftime("%d/%m/%Y %H:%M"), "ultimo_dia": last["data"] if last else None,
            "serie": serie, "treinos": workouts[:20]}


def summary(data: dict[str, Any]) -> dict[str, Any]:
    """Resumo para voz/cartão: último dia com dados e médias de 7 dias."""
    serie = [r for r in data.get("serie", []) if r.get("passos") or r.get("sono_h")]
    if not serie:
        return {}
    last = serie[-1]
    week = serie[-7:]

    def avg(k: str):
        vals = [r[k] for r in week if r.get(k)]
        return round(sum(vals) / len(vals), 1) if vals else None

    return {
        "dia": last["data"],
        "passos": last.get("passos"),
        "sono_h": last.get("sono_h"),
        "fc_repouso": last.get("fc_repouso"),
        "vfc": last.get("vfc"),
        "media7_passos": avg("passos"),
        "media7_sono": avg("sono_h"),
        "ultimo_treino": (data.get("treinos") or [None])[0],
        "exportado_em": data.get("atualizado"),
    }
