`timescale 1ns/1ps
// Independent shift-queue reference for a pointer-based FIFO implementation.
module tb;
  reg clk = 0;
  always #5 clk = !clk;
  reg rst_n = 0, push = 0, pop = 0;
  reg [7:0] din = 0;
  wire [7:0] dout;
  wire full, empty;
  fifo dut(clk, rst_n, push, pop, din, dout, full, empty);
  reg [7:0] expected [0:3];
  integer size = 0, seed, i, j, fd;
  integer empty_hits = 0, full_hits = 0, simultaneous_hits = 0;
  integer overflow_hits = 0, underflow_hits = 0, reset_hits = 0;
  reg [31:0] rng;
  reg accept_push, accept_pop;

  task tick(input reg do_push, input reg do_pop, input reg [7:0] value);
    begin
      @(negedge clk);
      push = do_push; pop = do_pop; din = value;
      #1;
      if (full !== (size == 4) || empty !== (size == 0))
        $fatal(1, "flag mismatch seed=%0d size=%0d", seed, size);
      accept_push = do_push && size < 4;
      accept_pop = do_pop && size > 0;
      if (size == 0) empty_hits = empty_hits + 1;
      if (size == 4) full_hits = full_hits + 1;
      if (do_push && size == 4) overflow_hits = overflow_hits + 1;
      if (do_pop && size == 0) underflow_hits = underflow_hits + 1;
      if (accept_push && accept_pop) simultaneous_hits = simultaneous_hits + 1;
      if (accept_pop) begin
        if (dout !== expected[0]) $fatal(1, "data mismatch seed=%0d", seed);
        for (j = 0; j < 3; j = j + 1) expected[j] = expected[j+1];
        size = size - 1;
      end
      if (accept_push) begin expected[size] = value; size = size + 1; end
      @(posedge clk); #1;
      if (full !== (size == 4) || empty !== (size == 0))
        $fatal(1, "post-cycle flag mismatch seed=%0d size=%0d", seed, size);
    end
  endtask

  task reset_fifo;
    begin
      @(negedge clk); rst_n = 0; push = 0; pop = 0;
      @(posedge clk); #1;
      size = 0;
      if (empty !== 1 || full !== 0) $fatal(1, "reset failed seed=%0d", seed);
      @(negedge clk); rst_n = 1; reset_hits = reset_hits + 1;
    end
  endtask

  initial begin
    if (!$value$plusargs("seed=%d", seed)) $fatal(1, "missing seed");
    rng = seed;
    $dumpfile("trace.vcd"); $dumpvars(0, tb);
    reset_fifo();
    tick(0, 1, 0);                        // Empty underflow.
    for (i = 0; i < 4; i = i + 1) tick(1, 0, 8'(i));
    tick(1, 0, 99);                       // Full overflow must preserve data.
    for (i = 0; i < 4; i = i + 1) tick(0, 1, 0);
    tick(1, 0, 41);
    for (i = 0; i < 20; i = i + 1) tick(1, 1, 8'(i + 42)); // Pointer wrap.
    reset_fifo();                         // Reset a nonempty queue.
    for (i = 0; i < 500; i = i + 1) begin
      rng = 32'd1664525 * rng + 32'd1013904223;
      tick(rng[30], rng[29], rng[7:0]);
    end
    while (size > 0) tick(0, 1, 0);
    fd = $fopen("results.json", "w");
    if (fd == 0) $fatal(1, "cannot open result");
    $fwrite(fd, "{\"schema\":1,\"seed\":%0d,\"checks\":[{\"id\":\"scoreboard\",\"passed\":true},{\"id\":\"reset\",\"passed\":true}],", seed);
    $fwrite(fd, "\"bins\":{\"empty\":%0d,\"full\":%0d,\"simultaneous\":%0d,\"overflow\":%0d,\"underflow\":%0d,\"reset\":%0d}}",
            empty_hits, full_hits, simultaneous_hits, overflow_hits, underflow_hits, reset_hits);
    $fclose(fd);
    $finish;
  end
  initial begin #200000; $fatal(1, "watchdog expired"); end
endmodule
