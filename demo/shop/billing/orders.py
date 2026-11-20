UNIT_PRICE = 10


def subtotal(qty):
    return qty * UNIT_PRICE


def bulk_discount(total):
    """10% off orders of more than 5 items."""
    return total * 0.9


def validate(total):
    if total < 0:
        raise ValueError("negative total: %s" % total)
    return total


def order_total(qty):
    total = subtotal(qty)
    if qty > 5:
        total = bulk_discount(total)
    return validate(total)
