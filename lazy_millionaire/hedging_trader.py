from fastapi import FastAPI
import random

app = FastAPI()

class Trade:
    def __init__(self, direction, amount):
        self.direction = direction  # 'buy' or 'sell'
        self.amount = amount
        self.loss_limit = amount * 0.01
        self.profit_target = amount * 0.04
        self.entry_price = None
        self.exit_price = None

    def set_entry_price(self, price):
        self.entry_price = price

    def close_trade(self, price):
        self.exit_price = price
        if self.direction == 'buy':
            profit = self.exit_price - self.entry_price
        else:
            profit = self.entry_price - self.exit_price
        return profit

@app.post("/hedge")
def hedge_trades():
    trade_amount = 1000  # Example amount
    directional_trade = Trade(direction='buy', amount=trade_amount)
    directional_trade.set_entry_price(random.uniform(95, 105))  # Simulate entry price
    opposing_trade = Trade(direction='sell', amount=trade_amount)
    opposing_trade.set_entry_price(directional_trade.entry_price)

    # Simulate some market fluctuation
    market_price = random.uniform(90, 110)
    profit = directional_trade.close_trade(market_price)
    opposing_profit = opposing_trade.close_trade(market_price)

    return {"profit": profit, "opposing_profit": opposing_profit}
