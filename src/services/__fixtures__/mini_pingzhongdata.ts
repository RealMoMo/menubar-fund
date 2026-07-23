// 精简但字段完整的 pingzhongdata 测试样本
// 真实文件 754KB 太大,这里造一个等价格式的小样本
export const MINI_PINGZHONGDATA = `/* 测试数据 *//*2026-07-22*/
var ishb=false;
var fS_name = "华夏成长混合";
var fS_code = "000001";
var fund_sourceRate="1.50";
var fund_minsg="10";
var syl_1n="61.13";
var syl_1y="-0.14";
var syl_3y="28.9";
var syl_6y="21.02";
var Data_netWorthTrend = [{"x":1784476800000,"y":1.306,"equityReturn":-0.99,"unitMoney":""},{"x":1784563200000,"y":1.445,"equityReturn":10.64,"unitMoney":""}];
var Data_currentFundManager =[{"id":"30040527","pic":"https://pdf.dfcfw.com/pdf/H8_30040527_1.JPG","name":"郑晓辉","star":5,"workTime":"14年又225天","fundSize":"116.55亿(4只基金)"}];
var stockCodesNew =["0.300308","1.688347","1.688361","0.002371"];
`;

export const MINI_FUND_SEARCH = `﻿var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIACHENGZHANGHUNHE"],["000002","HXCZHH","华夏成长混合(后端)","混合型-灵活","HUAXIACHENGZHANGHUNHE"],["110011","YFDHH","易方达优势成长混合","混合型","YIFANGDAYOUSHICHENGZHANGHUNHE"]];
`;

// 404 响应样本(模拟接口失效)
export const ERROR_404_RESPONSE = `<html><head><title>页面未找到 - 东方财富网</title></head><body>404</body></html>`;

// 空响应
export const EMPTY_RESPONSE = "";
