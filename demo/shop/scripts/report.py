from analytics import weekly_report


class ReportJob:
    def __init__(self, rows):
        self.rows = rows

    def run(self):
        return self.render(weekly_report(self.rows))

    def render(self, data):
        return "\n".join(f"{d['day']}: {d['rate']:.1%}" for d in data)


if __name__ == "__main__":
    print(ReportJob([{"day": "Mon", "orders": 3, "visits": 120}, {"day": "Tue", "orders": 0, "visits": 0}]).run())
