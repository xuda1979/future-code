module fifo(input logic clk, rst_n, push, pop,
            input logic [7:0] din,
            output logic [7:0] dout,
            output logic full, empty);
  logic [7:0] memory [0:3];
  logic [1:0] rd_ptr, wr_ptr;
  logic [2:0] count;
  wire take_push = push && !full;
  wire take_pop = pop && !empty;
  assign full = count == 4;
  assign empty = count == 0;
  assign dout = memory[rd_ptr];
  always @(posedge clk) begin
    if (!rst_n) begin
      rd_ptr <= 0;
      wr_ptr <= 0;
      count <= 0;
    end else begin
      if (take_push) begin
        memory[wr_ptr] <= din;
        wr_ptr <= wr_ptr + 1'b1;
      end
      if (take_pop) rd_ptr <= rd_ptr + 1'b1;
      case ({take_push, take_pop})
        2'b10: count <= count + 1'b1;
        2'b01: count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end
endmodule
