import unittest

from billing.orders import order_total


class OrdersTest(unittest.TestCase):
    def test_bulk_order(self):
        self.assertEqual(order_total(10), 90)

    def test_small_order(self):
        self.assertEqual(order_total(2), 20)
