<?php
declare(strict_types=1);

namespace Tally;

final class Cart
{
    public const TAX_RATE = 0.08;

    /** @var list<array{sku: string, price: float, qty: int}> */
    private array $items = [];

    public function add(string $sku, float $price, int $qty = 1): void
    {
        if ($price < 0 || $qty < 1) {
            throw new \InvalidArgumentException("Invalid item: $sku");
        }
        $this->items[] = ['sku' => $sku, 'price' => $price, 'qty' => $qty];
    }

    /** @return list<array{sku: string, price: float, qty: int}> */
    public function items(): array
    {
        return $this->items;
    }

    public function subtotal(): float
    {
        $sum = 0.0;
        foreach ($this->items as $item) {
            $sum += $item['price'] * $item['qty'];
        }
        return round($sum, 2);
    }

    public function tax(): float
    {
        return round($this->subtotal() * self::TAX_RATE, 2);
    }

    public function total(): float
    {
        return round($this->subtotal() + $this->tax(), 2);
    }
}
