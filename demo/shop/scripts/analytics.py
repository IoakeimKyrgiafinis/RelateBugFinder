def conversion_rate(orders, visits):
    return orders / visits


def weekly_report(rows):
    return [summarize(r) for r in rows]


def summarize(row):
    return {"day": row["day"], "rate": conversion_rate(row["orders"], row["visits"])}
