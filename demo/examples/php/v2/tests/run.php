<?php
declare(strict_types=1);

require __DIR__ . '/../src/Cart.php';
require __DIR__ . '/../src/Invoice.php';

use Tally\Cart;

$failures = 0;
function check(string $name, bool $ok): void
{
    global $failures;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failures++;
    }
}

$cart = new Cart();
$cart->addItem('pen', 150, 4);
$cart->addItem('book', 1200, 1, 'books');
$t = $cart->totals();
check('subtotal in cents', $t['subtotal'] === 1800);
check('per-category tax', $t['tax'] === 48 + 48);
check('total in cents', $t['total'] === 1896);

$food = new Cart();
$food->addItem('apple', 40, 10, 'food');
check('food is untaxed', $food->totals()['tax'] === 0);

$pct = new Cart();
$pct->addItem('pen', 1000, 2);
$pct->applyCoupon('save10');
$t = $pct->totals();
check('percent coupon', $t['discount'] === 200 && $t['total'] === 1944);

$flat = new Cart();
$flat->addItem('pen', 300);
$flat->applyCoupon('FLAT5');
check('flat coupon capped at subtotal', $flat->totals()['discount'] === 300 && $flat->totals()['total'] === 0);

$threw = 0;
foreach ([fn() => $cart->applyCoupon('NOPE'), fn() => $cart->addItem('x', 1, 1, 'toys'), fn() => $cart->addItem('x', -1)] as $f) {
    try {
        $f();
    } catch (InvalidArgumentException) {
        $threw++;
    }
}
check('rejects bad coupon, category and price', $threw === 3);

$text = Tally\renderInvoice($pct);
check('invoice shows discount', str_contains($text, 'Discount') && str_contains($text, '-$2.00'));
check('invoice shows total', str_contains($text, '$19.44'));

$out = shell_exec('php ' . escapeshellarg(__DIR__ . '/../bin/cart') . ' --coupon SAVE10 pen=10*2 2>&1');
check('cli applies coupon', is_string($out) && str_contains($out, '$19.44'));

exit($failures > 0 ? 1 : 0);
