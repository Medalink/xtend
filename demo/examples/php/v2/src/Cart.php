<?php
declare(strict_types=1);

namespace Tally;

final class Cart
{
    /** Tax rate in basis points per item category. */
    public const TAX_RATES = ['general' => 800, 'food' => 0, 'books' => 400];

    /** Percent coupons are an int percentage, flat coupons are cents off. */
    public const COUPONS = ['SAVE10' => ['percent', 10], 'FLAT5' => ['flat', 500]];

    /** @var list<array{sku: string, cents: int, qty: int, category: string}> */
    private array $items = [];
    private ?string $coupon = null;

    public function addItem(string $sku, int $cents, int $qty = 1, string $category = 'general'): void
    {
        if ($cents < 0 || $qty < 1) {
            throw new \InvalidArgumentException("Invalid item: $sku");
        }
        if (!isset(self::TAX_RATES[$category])) {
            throw new \InvalidArgumentException("Unknown category: $category");
        }
        $this->items[] = ['sku' => $sku, 'cents' => $cents, 'qty' => $qty, 'category' => $category];
    }

    public function applyCoupon(string $code): void
    {
        $code = strtoupper($code);
        if (!isset(self::COUPONS[$code])) {
            throw new \InvalidArgumentException("Unknown coupon: $code");
        }
        $this->coupon = $code;
    }

    /** @return list<array{sku: string, cents: int, qty: int, category: string}> */
    public function items(): array
    {
        return $this->items;
    }

    /** @return array{subtotal: int, discount: int, tax: int, total: int} all in cents */
    public function totals(): array
    {
        $subtotal = 0;
        foreach ($this->items as $item) {
            $subtotal += $item['cents'] * $item['qty'];
        }
        $discount = 0;
        if ($this->coupon !== null) {
            [$kind, $value] = self::COUPONS[$this->coupon];
            $discount = $kind === 'percent' ? intdiv($subtotal * $value, 100) : min($value, $subtotal);
        }
        $tax = 0;
        foreach ($this->items as $item) {
            $line = $item['cents'] * $item['qty'];
            $share = $subtotal > 0 ? intdiv($line * ($subtotal - $discount), $subtotal) : 0;
            $tax += intdiv($share * self::TAX_RATES[$item['category']] + 5000, 10000);
        }
        return [
            'subtotal' => $subtotal,
            'discount' => $discount,
            'tax' => $tax,
            'total' => $subtotal - $discount + $tax,
        ];
    }
}
